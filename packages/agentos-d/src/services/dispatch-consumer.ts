/**
 * DispatchConsumer — drains dispatch_queue rows that target known agents.
 *
 * What this is: scaffolding. The consumer claims a queued row by atomically
 * transitioning it queued→dispatched, looks up the target agent, hands the
 * task to a pluggable AgentAdapter, then transitions the row to completed
 * (or failed on adapter error). It also stamps the agent's runtime_state
 * heartbeat with token + cost counters returned by the adapter.
 *
 * What this is NOT: an LLM runtime. The default adapter is `stubAdapter`,
 * which immediately reports completion. Real adapters (local gateway,
 * Anthropic-direct, etc.) plug in via `setAdapter()` or by passing one to
 * the constructor.
 *
 * Disabled by default in local recovery mode. Enable with
 * AWOS_NATIVE_DISPATCH_ENABLED=1 or AGENTOS_DISPATCH_CONSUMER_ENABLED=true.
 */

import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { onDispatchResolved } from "./loop-driver.js";
import type { Config } from "../config.js";

export interface AdapterAgentSummary {
  id: string;
  tenantId: string;
  role: string | null;
  model: string | null;
  adapterType: string | null;
  instructionsPath: string | null;
}

export interface AdapterInput {
  taskId: string;
  tenantId: string;
  taskKind: string;
  targetAgentId: string;
  agent: AdapterAgentSummary;
  payload: Record<string, unknown>;
  riskScore?: number;
  reasons?: string[];
  autopilotDecision?: string;
}

export type AdapterOutcome =
  | {
      status: "completed";
      summary?: string;
      tokensInput?: number;
      tokensOutput?: number;
      tokensCached?: number;
      costCents?: number;
    }
  | { status: "failed"; error: string };

export interface AgentAdapter {
  /** Adapter must not mutate dispatch_queue rows; return outcome to consumer. */
  run(input: AdapterInput): Promise<AdapterOutcome>;
}

/**
 * No-op adapter. Reports completion immediately. Useful for testing the
 * consumer plumbing and as a placeholder when no real adapter is registered.
 */
export const stubAdapter: AgentAdapter = {
  async run() {
    return {
      status: "completed",
      summary: "stub adapter: dispatch acknowledged",
    };
  },
};

export interface DispatchConsumerOptions {
  sqlite: Database;
  adapter?: AgentAdapter;
  /** How often to tick when started. Ignored when calling tick() directly. */
  intervalMs?: number;
  /** Max queued items handled per tick. */
  batchSize?: number;
  /** Skip target agents in these statuses. Default ["paused", "retired"]. */
  skipAgentStatuses?: string[];
  /** Optional logger. */
  logger?: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
  /** Claim rows for legacy local_gateway agents. Default false unless explicitly enabled. */
  claimLocalGateway?: boolean;
  /**
   * Config to pass to onDispatchResolved so the loop-driver can resume
   * native-automation runs with real config rather than the {} fallback.
   * If omitted, onDispatchResolved falls back to loadConfig() at call time.
   */
  config?: Config;
}

export interface TickResult {
  scanned: number;
  claimed: number;
  completed: number;
  failed: number;
}

interface DispatchRow {
  id: string;
  tenant_id: string;
  task_kind: string;
  target_agent_id: string;
  input: string;
  status: "queued" | "waiting" | "dispatched" | "completed" | "failed";
  created_at: string;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  status: string;
  role: string | null;
  model: string | null;
  adapter_type: string | null;
  instructions_path: string | null;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH = 5;

function issueIdFromDispatchInput(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const direct = (parsed as { issueId?: unknown }).issueId;
  if (typeof direct === "string") return direct;
  const payload = (parsed as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;
  const nested = (payload as { issueId?: unknown }).issueId;
  return typeof nested === "string" ? nested : null;
}

export class DispatchConsumer {
  private readonly sqlite: Database;
  private adapter: AgentAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly skipStatuses: Set<string>;
  private readonly logger: NonNullable<DispatchConsumerOptions["logger"]>;
  private readonly claimLocalGateway: boolean;
  private readonly config: Config | undefined;
  private timer: NodeJS.Timeout | null = null;
  /** target_agent_id → in-flight adapter promise. Prevents two dispatches to the same agent in parallel. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly concurrencyCap = Number(process.env.AGENTOS_DISPATCH_CONCURRENCY ?? "5");

  constructor(opts: DispatchConsumerOptions) {
    this.sqlite = opts.sqlite;
    this.adapter = opts.adapter ?? stubAdapter;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.skipStatuses = new Set(opts.skipAgentStatuses ?? ["paused", "retired"]);
    this.claimLocalGateway = opts.claimLocalGateway ?? claimLocalGatewayDispatch();
    this.config = opts.config;
    this.logger =
      opts.logger ?? {
        info: () => {},
        warn: () => {},
        error: () => {},
      };
  }

  setAdapter(adapter: AgentAdapter): void {
    this.adapter = adapter;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    this.logger.info("dispatch-consumer started", {
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("dispatch-consumer stopped");
    }
  }

  async tick(): Promise<TickResult> {
    // Concurrent ticks are safe: tryClaim is atomic (UPDATE…WHERE status='queued')
    // and the inFlight map prevents two dispatches to the same agent.
    // Removing the prior `running` lock enables cross-tick parallelism so a
    // long adapter run on one agent doesn't block fetching for others.
    return await this.runTick();
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error("dispatch-consumer tick failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runTick(): Promise<TickResult> {
    const queued = this.fetchQueued();
    const result: TickResult = {
      scanned: queued.length,
      claimed: 0,
      completed: 0,
      failed: 0,
    };

    const pending = [...queued];
    while (pending.length > 0) {
      const launches: Promise<void>[] = [];

      for (let index = 0; index < pending.length; ) {
        const row = pending[index];
        if (!row) break;
        // Skip if this agent already has a dispatch in flight (same agent runs serially).
        if (this.inFlight.has(row.target_agent_id)) {
          index++;
          continue;
        }
        // Skip if we're at the global concurrency cap.
        if (this.inFlight.size >= this.concurrencyCap) break;
        const claimed = this.tryClaim(row.id);
        pending.splice(index, 1);
        if (!claimed) continue;
        result.claimed++;

        const launch = this.processOne(row, result).catch((err) => {
          this.logger.error("dispatch-consumer processOne crashed", {
            rowId: row.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }).finally(() => {
          this.inFlight.delete(row.target_agent_id);
        });
        this.inFlight.set(row.target_agent_id, launch);
        launches.push(launch);
      }

      if (launches.length === 0) break;
      // Await this wave so same-agent rows can continue serially inside one manual tick
      // while different agents still run concurrently.
      await Promise.all(launches);
    }
    return result;
  }

  private async processOne(row: DispatchRow, result: TickResult): Promise<void> {
    const agent = this.lookupAgent(row.target_agent_id);
    if (!agent) {
      const completedAt = this.markFailed(row.id, "target agent not found");
      this.reconcileIssueFromDispatch(row, "blocked", completedAt, "Dispatch failed: target agent not found.");
      result.failed++;
      return;
    }
    if (agent.tenant_id !== row.tenant_id) {
      const completedAt = this.markFailed(row.id, "tenant mismatch");
      this.reconcileIssueFromDispatch(row, "blocked", completedAt, "Dispatch failed: tenant mismatch.");
      result.failed++;
      return;
    }
    if (this.skipStatuses.has(agent.status)) {
      const completedAt = this.markFailed(row.id, `agent in status ${agent.status}`);
      this.reconcileIssueFromDispatch(row, "blocked", completedAt, `Dispatch failed: agent in status ${agent.status}.`);
      result.failed++;
      return;
    }

    let payload: Record<string, unknown>;


    try {
      const parsed = JSON.parse(row.input) as Record<string, unknown>;
      payload = parsed;

    } catch {
      payload = {};
    }

    let outcome: AdapterOutcome;
    try {
      const riskScore = typeof payload.riskScore === "number" ? payload.riskScore : undefined;
      const reasons = Array.isArray(payload.reasons)
        ? payload.reasons.filter((reason): reason is string => typeof reason === "string")
        : undefined;
      const autopilotDecision =
        typeof payload.autopilotDecision === "string" ? payload.autopilotDecision : undefined;
      const adapterInput: Parameters<typeof this.adapter.run>[0] = {
        taskId: row.id,
        tenantId: row.tenant_id,
        taskKind: row.task_kind,
        targetAgentId: row.target_agent_id,
        agent: {
          id: agent.id,
          tenantId: agent.tenant_id,
          role: agent.role,
          model: agent.model,
          adapterType: agent.adapter_type,
          instructionsPath: agent.instructions_path,
        },
        payload,
        ...(riskScore !== undefined ? { riskScore } : {}),
        ...(reasons !== undefined ? { reasons } : {}),
        ...(autopilotDecision !== undefined ? { autopilotDecision } : {}),
      };
      outcome = await this.adapter.run(adapterInput);
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (outcome.status === "completed") {
      const completedAt = this.markCompleted(row.id);
      const commentBody = `Dispatch completed${outcome.summary ? `: ${outcome.summary}` : "."} Issue moved to review.`;
      this.reconcileIssueFromDispatch(
        row,
        "review",
        completedAt,
        commentBody
      );
      this.recordHeartbeat(agent, outcome);
      result.completed++;
      onDispatchResolved(row.id, "completed", this.config).catch((err: unknown) => {
        this.logger.error("loop-driver: onDispatchResolved(completed) failed", {
          rowId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      const completedAt = this.markFailed(row.id, outcome.error);
      this.reconcileIssueFromDispatch(row, "blocked", completedAt, `Dispatch failed: ${outcome.error}`);
      result.failed++;
      onDispatchResolved(row.id, "failed", this.config).catch((err: unknown) => {
        this.logger.error("loop-driver: onDispatchResolved(failed) failed", {
          rowId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private fetchQueued(): DispatchRow[] {
    const localGatewayFilter = this.claimLocalGateway
      ? ""
      : "AND (ea.adapter_type IS NULL OR ea.adapter_type != 'local_gateway')";

    return this.sqlite
      .prepare(
        `SELECT dq.id, dq.tenant_id, dq.task_kind, dq.target_agent_id,
                dq.input, dq.status, dq.created_at
         FROM dispatch_queue dq
         LEFT JOIN execution_agents ea ON ea.id = dq.target_agent_id
         WHERE dq.status IN ('queued', 'waiting')
           ${localGatewayFilter}
         ORDER BY dq.created_at ASC
         LIMIT ?`,
      )
      .all(this.batchSize) as DispatchRow[];
  }

  /** Atomic claim: returns true iff this call moved queued/waiting→dispatched. */
  private tryClaim(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE dispatch_queue
         SET status = 'dispatched', dispatched_at = ?
         WHERE id = ? AND status IN ('queued', 'waiting')`
      )
      .run(now, id);
    return result.changes === 1;
  }

  private lookupAgent(agentId: string): AgentRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, tenant_id, status, role, model, adapter_type, instructions_path
         FROM execution_agents WHERE id = ?`
      )
      .get(agentId) as AgentRow | undefined;
  }

  private markCompleted(id: string): string {
    const completedAt = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE dispatch_queue
         SET status = 'completed', completed_at = ?
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(completedAt, id);
    return completedAt;
  }

  private markFailed(id: string, error: string): string {
    const completedAt = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE dispatch_queue
         SET status = 'failed', completed_at = ?, error = ?
         WHERE id = ? AND status IN ('queued', 'dispatched')`
      )
      .run(completedAt, error, id);
    return completedAt;
  }

  private reconcileIssueFromDispatch(
    row: DispatchRow,
    nextStatus: "review" | "blocked",
    completedAt: string,
    body: string,
  ): void {
    const issueId = issueIdFromDispatchInput(row.input);
    if (!issueId) return;

    const issue = this.sqlite
      .prepare("SELECT id, tenant_id, identifier, status FROM execution_issues WHERE id = ?")
      .get(issueId) as { id: string; tenant_id: string; identifier: string | null; status: string } | undefined;
    if (!issue) return;
    if (issue.status === "done" || issue.status === "closed") return;
    if (nextStatus === "review" && issue.status === "blocked") return;

    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE execution_issues
         SET status = ?, updated_at = ?, completed_at = NULL
         WHERE id = ?`
      )
      .run(nextStatus, now, issue.id);

    this.sqlite
      .prepare(
        `INSERT INTO execution_issue_comments
         (id, tenant_id, issue_id, author_id, author_label, body, created_at)
         VALUES (?, ?, ?, NULL, 'Coordinator', ?, ?)`
      )
      .run(
        randomUUID(),
        issue.tenant_id,
        issue.id,
        `Dispatch ${row.id} finished at ${completedAt}. ${body}`,
        now,
      );
  }

  private recordHeartbeat(agent: AgentRow, outcome: Extract<AdapterOutcome, { status: "completed" }>): void {
    const now = new Date().toISOString();
    const existing = this.sqlite
      .prepare(
        `SELECT total_input_tokens, total_output_tokens, total_cached_input_tokens, total_cost_cents
         FROM execution_agent_runtime_state WHERE agent_id = ?`
      )
      .get(agent.id) as
      | {
          total_input_tokens: number;
          total_output_tokens: number;
          total_cached_input_tokens: number;
          total_cost_cents: number;
        }
      | undefined;

    const tokensInput = outcome.tokensInput ?? 0;
    const tokensOutput = outcome.tokensOutput ?? 0;
    const tokensCached = outcome.tokensCached ?? 0;
    const costCents = outcome.costCents ?? 0;

    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE execution_agent_runtime_state SET
             last_run_status = 'succeeded',
             last_run_at = ?,
             total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             total_cached_input_tokens = total_cached_input_tokens + ?,
             total_cost_cents = total_cost_cents + ?,
             updated_at = ?
           WHERE agent_id = ?`
        )
        .run(now, tokensInput, tokensOutput, tokensCached, costCents, now, agent.id);
    } else {
      this.sqlite
        .prepare(
          `INSERT INTO execution_agent_runtime_state
             (agent_id, tenant_id, last_run_id, last_run_status, last_run_at,
              total_input_tokens, total_output_tokens, total_cached_input_tokens,
              total_cost_cents, updated_at)
           VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          agent.id,
          agent.tenant_id,
          randomUUID(),
          now,
          tokensInput,
          tokensOutput,
          tokensCached,
          costCents,
          now
        );
    }

    this.sqlite
      .prepare(`UPDATE execution_agents SET last_heartbeat_at = ? WHERE id = ?`)
      .run(now, agent.id);
  }
}

export function dispatchConsumerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.AGENTOS_DISPATCH_CONSUMER_ENABLED;
  if (explicit !== undefined) return explicit !== "false" && explicit !== "0";
  return env.AWOS_NATIVE_DISPATCH_ENABLED === "1" || env.AWOS_NATIVE_DISPATCH_ENABLED === "true";
}

export function claimLocalGatewayDispatch(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env.AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH === "1" ||
    env.AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH === "true"
  );
}

export function dispatchConsumerOptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): { intervalMs: number; batchSize: number } {
  const interval = Number(env.AGENTOS_DISPATCH_CONSUMER_INTERVAL_MS);
  const batch = Number(env.AGENTOS_DISPATCH_CONSUMER_BATCH);
  return {
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS,
    batchSize: Number.isFinite(batch) && batch > 0 ? batch : DEFAULT_BATCH,
  };
}
