/**
 * KimiReviewAdapter — ReviewAgent auto-review of BE/FE submissions.
 *
 * Triggered when an issue lands at status=review with assignee=ReviewAgent. The
 * adapter:
 *   1. Loads the issue body's pass/fail checklist + the assignee's
 *      "Ready for review" close comment + the assignee role's AGENTS.md
 *      (so it knows the quality bar that lane was held to).
 *   2. Runs read-only tools (read_file, list_dir, grep, run_test) to
 *      verify the checklist against the actual diff and tests.
 *   3. Calls either approve(verdict) → close as done, or
 *      request_changes(feedback) → revert to todo, prepend feedback to
 *      the issue body so the next BE/FE run sees it, and fire a wakeup
 *      on the original assignee so wake-on-assign's SEEN_FILE dedupe
 *      doesn't strand the retry.
 *
 * Lane: read-only across the repo. The adapter never writes code.
 * Cap: 25 turns (review is comparison work, not authoring).
 */
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { AgentAdapter, AdapterInput, AdapterOutcome } from "../services/dispatch-consumer.js";
import { loadAwosProviderKey } from "./awos-secrets.js";
import { runSafeTestCommand } from "./safe-test-runner.js";

const REPO_ROOT = process.env.AWOS_REPO_ROOT ?? process.cwd();
const KIMI_BASE_URL = process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1";
const KIMI_MODEL = process.env.KIMI_REVIEW_MODEL ?? process.env.KIMI_MODEL ?? "kimi-k2-turbo-preview";
const AWOS_PROVIDER_PROFILE_PATH = process.env.AWOS_PROVIDER_PROFILE_PATH ?? `${process.env.HOME}/.agentworks/provider-profile.yaml`;
const MAX_TURNS = Number(process.env.AWOS_REVIEW_MAX_TURNS ?? "25");
const FILE_READ_CAP_BYTES = 100_000;
const TEST_TIMEOUT_MS = 90_000;

const REVIEW_AGENT_ID = "d78ae419-ef4f-4e68-91b9-98405aa2b63f";
const EXAMPLE_BACKEND_AGENT_ID = "00000000-0000-4000-8000-000000000004";
const EXAMPLE_FRONTEND_AGENT_ID = "00000000-0000-4000-8000-000000000005";
const EXAMPLE_PYTHON_AGENT_ID = "00000000-0000-4000-8000-000000000006";

interface ResolvedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  assigneeAgentId: string | null;
  tenantId: string;
}

function loadKimiKey(): string {
  return loadAwosProviderKey({
    envNames: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    providerProfilePath: AWOS_PROVIDER_PROFILE_PATH,
    providerProfileName: "kimi",
  });
}

const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file relative to repo root. Returns first 100KB.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a directory relative to repo root.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Recursive grep across the repo (or under path). Up to 100 matching lines.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run vitest in a package directory. Returns truncated output. 90s timeout.",
      parameters: {
        type: "object",
        properties: {
          package_dir: { type: "string", description: "Path relative to repo root, e.g. packages/agentos-d" },
          test_file: { type: "string", description: "Optional specific test file to narrow the run." },
        },
        required: ["package_dir"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "approve",
      description:
        "Close the issue as done with verdict 'Approved.'. Use when every pass/fail item passes and the AGENTS.md quality bar is met. Provide a one-paragraph summary of what you verified.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_changes",
      description:
        "Revert the issue to todo with verdict 'Changes requested:'. Use when ANY pass/fail item or AGENTS.md quality bar item fails. List each failure as a numbered item naming the specific file/test/rule. The agent will receive your feedback prepended to the issue body on retry.",
      parameters: {
        type: "object",
        properties: {
          feedback: {
            type: "string",
            description: "Numbered list of specific, actionable items the engineer must address before re-submitting.",
          },
        },
        required: ["feedback"],
      },
    },
  },
];

export interface KimiReviewAdapterOptions {
  sqlite: Database.Database;
  client?: OpenAI;
  repoRoot?: string;
  logger?: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };
}

interface ReviewContext {
  issue: ResolvedIssue;
  testRuns: number;
}

export class KimiReviewAdapter implements AgentAdapter {
  private sqlite: Database.Database;
  private client: OpenAI;
  private repoRoot: string;
  private log: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };

  constructor(opts: KimiReviewAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.log = opts.logger ?? {
      info: (m, c) => console.log(`[kimi-review] ${m}`, c ?? ""),
      warn: (m, c) => console.warn(`[kimi-review] ${m}`, c ?? ""),
      error: (m, c) => console.error(`[kimi-review] ${m}`, c ?? ""),
    };
    this.client = opts.client ?? new OpenAI({ apiKey: loadKimiKey(), baseURL: KIMI_BASE_URL });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) return { status: "failed", error: "payload.issueId missing" };

    const issue = this.loadIssue(issueId);
    if (!issue) return { status: "failed", error: `issue ${issueId} not found` };
    if (issue.status !== "review") {
      return { status: "completed", summary: `kimi-review: skipped — status=${issue.status}` };
    }
    if (issue.assigneeAgentId !== REVIEW_AGENT_ID) {
      return { status: "completed", summary: `kimi-review: skipped — assignee is not ReviewAgent` };
    }

    const closeComment = this.loadLatestCloseComment(issue.id);
    const reviewedRole = inferAssigneeRoleFromTitle(issue.title, closeComment?.body ?? issue.description);
    if (!reviewedRole) {
      return {
        status: "failed",
        error: `kimi-review: cannot infer reviewed role from title "${issue.title.slice(0, 40)}…"`,
      };
    }

    this.log.info(`REVIEW start ${issue.identifier} title="${issue.title.slice(0, 50)}"`);

    const reviewMd = this.safeRead(path.join(this.repoRoot, "agents/review/AGENTS.md")) ?? "";
    const reviewedAgentMd =
      this.safeRead(path.join(this.repoRoot, `agents/${reviewedRole.agentsDir}/AGENTS.md`)) ?? "";
    const repoMd = this.safeRead(path.join(this.repoRoot, "CLAUDE.md")) ?? "";
    const gateMd = this.safeRead(path.join(this.repoRoot, "agents/_shared/CEO-REVIEW-GATE.md")) ?? "";

    const systemPrompt = [
      "You are ReviewAgent running the Operator UX v2 review gate against a submission from a BE or FE engineer.",
      "Your job: verify the submission against the issue body's pass/fail checklist AND the engineer's AGENTS.md quality bar.",
      "",
      "## Workflow",
      "1. Read the engineer's close comment (below) to learn which files they touched.",
      "2. Read each touched file via read_file. Check file size, structure, and that it actually does what the issue body asked.",
      "3. Run the affected tests via run_test (90s timeout). A passing test that only asserts `expect(X).toBeDefined()` is a STUB and fails the AGENTS.md quality bar — flag it.",
      "4. Walk every checklist item in the issue body's 'Pass/fail criteria' section and decide pass or fail.",
      "5. If every item passes, call approve(summary). If ANY item fails, call request_changes(feedback) with a numbered list naming specific files, tests, or rules.",
      "",
      "## Hard rules",
      `- ${MAX_TURNS} turns max. Be efficient: read each touched file once, run the affected tests once.`,
      "- Read-only: you cannot write_file or edit_file. Your only terminal actions are approve and request_changes.",
      "- Do not approve a stub test. Do not approve a file over 400 lines. Do not approve hardcoded fake data in admin-ui shell components.",
      "",
      "## Engineer's AGENTS.md (the quality bar this submission must meet)",
      reviewedAgentMd,
      "",
      "## Review responsibilities",
      reviewMd,
      "",
      "## Review gate (close-comment lifecycle)",
      gateMd,
      "",
      "## Repo conventions (CLAUDE.md)",
      repoMd,
    ].join("\n");

    const userPrompt = [
      `# Issue ${issue.identifier} (status=review, assignee=ReviewAgent)`,
      `Title: ${issue.title}`,
      "",
      "## Engineer's close comment (\"Ready for review\")",
      closeComment ? closeComment.body : "(no close comment found — flag this in your verdict)",
      "",
      "## Issue body (contains the pass/fail checklist)",
      issue.description,
    ].join("\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const ctx: ReviewContext = { issue, testRuns: 0 };
    let totalIn = 0;
    let totalOut = 0;
    let verdict: { kind: "approve" | "changes"; text: string } | null = null;
    let lastError: string | null = null;
    const toolHist: Record<string, number> = {};
    let turnsUsed = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turnsUsed = turn + 1;
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await this.client.chat.completions.create({
          model: KIMI_MODEL,
          messages,
          tools: TOOL_DEFS,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: 4000,
        });
      } catch (err) {
        lastError = `LLM call failed turn ${turn}: ${err instanceof Error ? err.message : String(err)}`;
        this.log.error(lastError);
        break;
      }
      totalIn += completion.usage?.prompt_tokens ?? 0;
      totalOut += completion.usage?.completion_tokens ?? 0;
      const choice = completion.choices?.[0];
      if (!choice) {
        lastError = "no completion choice";
        break;
      }
      const msg = choice.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        messages.push({
          role: "user",
          content:
            "You produced text without a tool call. Decide now: call approve or request_changes. " +
            "If you need more evidence, call read_file or run_test first.",
        });
        continue;
      }

      let terminal = false;
      for (const call of toolCalls) {
        if (call.type === "function") {
          const n = call.function.name;
          toolHist[n] = (toolHist[n] ?? 0) + 1;
        }
        const result = await this.dispatchTool(call, ctx);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        });
        if (result.terminal) {
          verdict = result.terminal;
          terminal = true;
        }
      }
      if (terminal) break;
    }

    const histStr = Object.entries(toolHist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const usage = { in: totalIn, out: totalOut };

    if (verdict?.kind === "approve") {
      this.transitionIssue(issue.id, "done");
      this.postComment(
        issue.id,
        issue.tenantId,
        ["## Approved.", "", verdict.text, "", `Reviewer: kimi-review-adapter (${KIMI_MODEL}); turns=${turnsUsed} hist=${histStr}`].join("\n")
      );
      this.log.info(`REVIEW approve ${issue.identifier}`, { ...usage, turns: turnsUsed });
      const outcome: AdapterOutcome = {
        status: "completed",
        summary: `kimi-review: ${issue.identifier} approved`,
      };
      if (usage.in) outcome.tokensInput = usage.in;
      if (usage.out) outcome.tokensOutput = usage.out;
      return outcome;
    }

    if (verdict?.kind === "changes") {
      const previousAssignee = this.lookupPreviousAssignee(issue.id, reviewedRole.agentId);
      this.prependFeedbackToIssueBody(issue.id, verdict.text);
      this.transitionIssue(issue.id, "todo", previousAssignee);
      this.postComment(
        issue.id,
        issue.tenantId,
        [
          "## Changes requested:",
          "",
          verdict.text,
          "",
          "Issue reverted to `todo`; feedback prepended to the issue body so your next attempt sees it inline.",
          `Reviewer: kimi-review-adapter (${KIMI_MODEL}); turns=${turnsUsed} hist=${histStr}`,
        ].join("\n")
      );
      this.fireWakeup(issue.tenantId, previousAssignee, issue.id, "review-changes-requested");
      this.log.info(`REVIEW changes ${issue.identifier}`, { ...usage, turns: turnsUsed });
      return { status: "completed", summary: `kimi-review: ${issue.identifier} changes requested` };
    }

    const reason = lastError ?? `max-turns ${MAX_TURNS} hit without verdict`;
    this.log.warn(`REVIEW bail ${issue.identifier}: ${reason} | turns=${turnsUsed} hist=${histStr}`);
    this.postComment(
      issue.id,
      issue.tenantId,
      ["## Auto-review did not finish", "", `Reason: ${reason}`, `Tool calls: ${histStr || "(none)"}`, "", "Issue stays at `review` for human attention."].join("\n")
    );
    return { status: "failed", error: `kimi-review: ${reason}` };
  }

  private async dispatchTool(
    call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    ctx: ReviewContext
  ): Promise<{ content: string; terminal?: { kind: "approve" | "changes"; text: string } }> {
    if (call.type !== "function") return { content: `error: unsupported tool call type "${call.type}"` };
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { content: `error: tool args were not valid JSON` };
    }
    try {
      switch (name) {
        case "read_file":
          return { content: await this.toolReadFile(String(args.path ?? "")) };
        case "list_dir":
          return { content: await this.toolListDir(String(args.path ?? "")) };
        case "grep":
          return { content: await this.toolGrep(String(args.pattern ?? ""), args.path ? String(args.path) : undefined) };
        case "run_test":
          return {
            content: await this.toolRunTest(String(args.package_dir ?? ""), args.test_file ? String(args.test_file) : undefined, ctx),
          };
        case "approve":
          return { content: "ok: approved", terminal: { kind: "approve", text: String(args.summary ?? "") } };
        case "request_changes":
          return { content: "ok: changes requested", terminal: { kind: "changes", text: String(args.feedback ?? "") } };
        default:
          return { content: `error: unknown tool ${name}` };
      }
    } catch (err) {
      return { content: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async toolReadFile(rel: string): Promise<string> {
    const abs = this.absInRepo(rel);
    if (!abs) return `error: invalid path "${rel}"`;
    if (!existsSync(abs)) return `error: file not found: ${rel}`;
    const buf = await fs.readFile(abs);
    if (buf.length > FILE_READ_CAP_BYTES) {
      return `--- ${rel} (truncated to ${FILE_READ_CAP_BYTES}/${buf.length} bytes) ---\n` + buf.subarray(0, FILE_READ_CAP_BYTES).toString("utf8");
    }
    return `--- ${rel} (${buf.length} bytes) ---\n` + buf.toString("utf8");
  }

  private async toolListDir(rel: string): Promise<string> {
    const abs = this.absInRepo(rel || ".");
    if (!abs) return `error: invalid path "${rel}"`;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  }

  private async toolGrep(pattern: string, rel?: string): Promise<string> {
    if (!pattern) return "error: pattern required";
    const abs = rel ? this.absInRepo(rel) : this.repoRoot;
    if (!abs) return `error: invalid path "${rel ?? ""}"`;
    return await new Promise((resolve) => {
      const args = ["-rn", "--max-count=4", "-E", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist", "--exclude-dir=.next", pattern, abs];
      const proc = spawn("/usr/bin/grep", args);
      let out = "";
      let bytes = 0;
      proc.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes < 12_000) out += chunk.toString("utf8");
      });
      proc.stderr.on("data", () => {});
      proc.on("close", () => {
        const cleaned = out.split("\n").filter(Boolean).slice(0, 100).map((l) => l.replace(this.repoRoot + "/", "")).join("\n");
        resolve(cleaned || "(no matches)");
      });
      setTimeout(() => proc.kill("SIGKILL"), 8000);
    });
  }

  private async toolRunTest(rel: string, testFile: string | undefined, ctx: ReviewContext): Promise<string> {
    ctx.testRuns++;
    if (ctx.testRuns > 6) return "error: review test-run budget exhausted (6 max)";
    const abs = this.absInRepo(rel);
    if (!abs) return `error: invalid package_dir "${rel}"`;
    if (!existsSync(abs)) return `error: package_dir not found: ${rel}`;
    return await runSafeTestCommand({ cwd: abs, testFile, timeoutMs: TEST_TIMEOUT_MS });
  }

  private absInRepo(rel: string): string | null {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return null;
    if (rel.includes("..")) return null;
    return path.join(this.repoRoot, rel.replace(/^\.\//, ""));
  }

  private safeRead(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  private loadIssue(id: string): ResolvedIssue | null {
    const row = this.sqlite
      .prepare("SELECT id, identifier, title, description, status, assignee_agent_id, tenant_id FROM execution_issues WHERE id = ?")
      .get(id) as
      | { id: string; identifier: string; title: string; description: string; status: string; assignee_agent_id: string | null; tenant_id: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description ?? "",
      status: row.status,
      assigneeAgentId: row.assignee_agent_id,
      tenantId: row.tenant_id,
    };
  }

  private loadLatestCloseComment(issueId: string): { body: string } | null {
    const row = this.sqlite
      .prepare(
        `SELECT body FROM execution_issue_comments
         WHERE issue_id = ? AND author_label = 'kimi-tool-adapter'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(issueId) as { body: string } | undefined;
    return row ?? null;
  }

  private lookupPreviousAssignee(issueId: string, fallback: string): string {
    // The original BE/FE assignee is captured at issue creation; the
    // submitter then reassigns to CEO. Walk audit-style by reading comments
    // posted by 'kimi-tool-adapter' and trust their agentId hint, but we
    // don't store it explicitly. Fallback to the role-mapped UUID from the title.
    return fallback;
  }

  private prependFeedbackToIssueBody(issueId: string, feedback: string): void {
    const row = this.sqlite.prepare("SELECT description FROM execution_issues WHERE id = ?").get(issueId) as { description: string } | undefined;
    const existing = row?.description ?? "";
    const block = [
      "## ⚠ Second pass — CEO requested changes on first submission",
      "",
      "Address these specific items before re-submitting (see also Operator UX v2 quality bar in agents/<role>/AGENTS.md):",
      "",
      feedback,
      "",
      "---",
      "",
      existing,
    ].join("\n");
    this.sqlite
      .prepare("UPDATE execution_issues SET description = ?, updated_at = ? WHERE id = ?")
      .run(block, new Date().toISOString(), issueId);
  }

  private transitionIssue(issueId: string, status: "todo" | "in_progress" | "review" | "done", assigneeAgentId?: string): void {
    const now = new Date().toISOString();
    if (assigneeAgentId !== undefined) {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, updated_at = ?, assignee_agent_id = ? WHERE id = ?")
        .run(status, now, assigneeAgentId, issueId);
    } else if (status === "done") {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(status, now, now, issueId);
    } else {
      this.sqlite
        .prepare("UPDATE execution_issues SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, issueId);
    }
  }

  private postComment(issueId: string, tenantId: string, body: string): void {
    const id = "kr-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
    const now = new Date().toISOString();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO execution_issue_comments (id, tenant_id, issue_id, author_id, author_label, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, tenantId, issueId, null, "kimi-review-adapter", body, now);
    } catch (err) {
      this.log.warn(`postComment skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fireWakeup(tenantId: string, agentId: string, issueId: string, reason: string): void {
    try {
      const id = randomUUID();
      const input = JSON.stringify({
        source: "auto-review",
        triggerDetail: reason,
        reason: `kimi-review-adapter: ${reason}`,
        payload: { issueId },
        idempotencyKey: `review-${issueId}-${Date.now()}`,
      });
      this.sqlite
        .prepare(
          `INSERT INTO dispatch_queue (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
           VALUES (?, ?, 'agent.wakeup', ?, ?, 'queued', ?)`
        )
        .run(id, tenantId, agentId, input, new Date().toISOString());
    } catch (err) {
      this.log.warn(`fireWakeup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function inferAssigneeRoleFromTitle(title: string, body = ""): { agentsDir: string; agentId: string } | null {
  if (title.startsWith("[BackendEngineer]")) return { agentsDir: "backend", agentId: EXAMPLE_BACKEND_AGENT_ID };
  if (title.startsWith("[FrontendEngineer]")) return { agentsDir: "frontend", agentId: EXAMPLE_FRONTEND_AGENT_ID };
  if (title.startsWith("[PythonEngineer]")) return { agentsDir: "python", agentId: EXAMPLE_PYTHON_AGENT_ID };
  if (body.includes("packages/admin-ui/")) return { agentsDir: "frontend", agentId: EXAMPLE_FRONTEND_AGENT_ID };
  if (body.includes("packages/scanner-worker/")) return { agentsDir: "python", agentId: EXAMPLE_PYTHON_AGENT_ID };
  if (
    body.includes("packages/agentos-d/") ||
    body.includes("packages/memory/") ||
    body.includes("packages/policy-engine/") ||
    body.includes("packages/shared/")
  ) {
    return { agentsDir: "backend", agentId: EXAMPLE_BACKEND_AGENT_ID };
  }
  return null;
}
