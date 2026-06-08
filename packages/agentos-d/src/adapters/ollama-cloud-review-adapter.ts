/**
 * OllamaCloudReviewAdapter — CEO auto-review of submissions, on Ollama Cloud.
 *
 * Cloned from KimiReviewAdapter with provider swap (Ollama Cloud, default
 * model glm-5.1, env override AGENTOS_REVIEW_MODEL) and these improvements:
 *
 *   - Previous-assignee lookup uses issue.metadata.previousAssigneeId (set
 *     by the worker on submit) instead of title-prefix matching. Works for
 *     issues with plain titles (no [BackendEngineer] prefix).
 *   - Close-comment author match accepts any of: kimi-tool-adapter,
 *     ollama-cloud-adapter, or any author whose label ends in -adapter.
 *   - Per-issue repo selection: reads issue.metadata.repoPath only when the
 *     path is listed in AWOS_ALLOWED_REPO_ROOTS.
 *
 * Lane: read-only across the repo. Cap: 25 turns.
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

const REPO_ROOT_PUBLIC =
  process.env.AWOS_PUBLIC_REPO ?? process.cwd();
const REPO_ROOT_LOCAL =
  process.env.AWOS_LOCAL_REPO ?? process.cwd();
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1";
const OLLAMA_REVIEW_MODEL = process.env.AGENTOS_REVIEW_MODEL ?? "minimax-m2.5";
const AWOS_PROVIDER_PROFILE_PATH = process.env.AWOS_PROVIDER_PROFILE_PATH ?? `${process.env.HOME}/.agentworks/provider-profile.yaml`;
const MAX_TURNS = Number(process.env.AGENTOS_REVIEW_MAX_TURNS ?? "25");
const FILE_READ_CAP_BYTES = 100_000;
const TEST_TIMEOUT_MS = 90_000;
const TRACE_DIR = process.env.AGENTOS_TRACE_DIR ?? "/tmp/agentos-issues";
const STREAM_ENABLED = (process.env.AGENTOS_STREAM ?? "1") !== "0";

const REVIEW_AGENT_ID = "d78ae419-ef4f-4e68-91b9-98405aa2b63f";

interface ResolvedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  assigneeAgentId: string | null;
  tenantId: string;
  metadata: Record<string, unknown>;
}

function loadOllamaKey(): string {
  return loadAwosProviderKey({
    envNames: ["OLLAMA_API_KEY"],
    providerProfilePath: AWOS_PROVIDER_PROFILE_PATH,
    providerProfileName: "ollama-cloud",
  });
}

function repoRootForIssue(issue: ResolvedIssue): string {
  const fromMetadata = issue.metadata.repoPath;
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
    const resolved = path.resolve(fromMetadata);
    const allowedRoots = (process.env.AWOS_ALLOWED_REPO_ROOTS ?? "")
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
    if (allowedRoots.includes(resolved) && existsSync(resolved)) return resolved;
  }
  return issue.metadata.repo === "local" ? REPO_ROOT_LOCAL : REPO_ROOT_PUBLIC;
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
      name: "git_diff",
      description: "Run `git diff <ref>` in repo root. Default ref is HEAD~1..HEAD. Returns up to 80KB of diff.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "Optional git ref or range." } },
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
        "Close the issue as done with verdict 'Approved.'. Use when every acceptance item passes and the AGENTS.md quality bar is met. Provide a one-paragraph summary of what you verified.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
  },
  {
    type: "function",
    function: {
      name: "request_changes",
      description:
        "Revert the issue to todo with verdict 'Changes requested:'. Use when ANY acceptance item or AGENTS.md quality bar item fails. List each failure as a numbered item naming the specific file/test/rule.",
      parameters: {
        type: "object",
        properties: {
          feedback: { type: "string", description: "Numbered list of specific, actionable items the engineer must address before re-submitting." },
        },
        required: ["feedback"],
      },
    },
  },
];

export interface OllamaCloudReviewAdapterOptions {
  sqlite: Database.Database;
  client?: OpenAI;
  logger?: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };
}

interface ReviewContext {
  issue: ResolvedIssue;
  repoRoot: string;
  testRuns: number;
}

export class OllamaCloudReviewAdapter implements AgentAdapter {
  private sqlite: Database.Database;
  private client: OpenAI;
  private log: { info: (m: string, c?: unknown) => void; warn: (m: string, c?: unknown) => void; error: (m: string, c?: unknown) => void };

  constructor(opts: OllamaCloudReviewAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.log = opts.logger ?? {
      info: (m, c) => console.log(`[ollama-review] ${m}`, c ?? ""),
      warn: (m, c) => console.warn(`[ollama-review] ${m}`, c ?? ""),
      error: (m, c) => console.error(`[ollama-review] ${m}`, c ?? ""),
    };
    this.client = opts.client ?? new OpenAI({ apiKey: loadOllamaKey(), baseURL: OLLAMA_BASE_URL });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) return { status: "failed", error: "payload.issueId missing" };

    const issue = this.loadIssue(issueId);
    if (!issue) return { status: "failed", error: `issue ${issueId} not found` };
    if (issue.status !== "review") {
      return { status: "completed", summary: `ollama-review: skipped — status=${issue.status}` };
    }
    if (issue.assigneeAgentId !== REVIEW_AGENT_ID) {
      return { status: "completed", summary: `ollama-review: skipped — assignee is not ReviewAgent` };
    }

    const previousAssigneeId = (issue.metadata.previousAssigneeId as string | undefined) ?? null;
    const previousAssigneeName = (issue.metadata.previousAssigneeName as string | undefined) ?? null;
    const repoRoot = repoRootForIssue(issue);
    const model = (typeof issue.metadata.reviewModel === "string" && issue.metadata.reviewModel) || OLLAMA_REVIEW_MODEL;

    this.log.info(`REVIEW start ${issue.identifier} prev=${previousAssigneeName ?? "?"} repo=${path.basename(repoRoot)} model=${model}`);

    const traceFile = path.join(TRACE_DIR, `${issue.identifier}.trace.jsonl`);
    await fs.mkdir(TRACE_DIR, { recursive: true });
    const traceStartedAt = Date.now();
    const trace = (event: Record<string, unknown>): void => {
      const line = JSON.stringify({ ts: new Date().toISOString(), elapsedMs: Date.now() - traceStartedAt, ...event }) + "\n";
      fs.appendFile(traceFile, line).catch(() => { /* trace failure must not break adapter */ });
    };
    trace({
      event: "review_start",
      issue: issue.identifier,
      issueId: issue.id,
      title: issue.title,
      previousAssignee: previousAssigneeName,
      repoRoot,
      model,
      streaming: STREAM_ENABLED,
      maxTurns: MAX_TURNS,
    });

    const closeComment = this.loadLatestCloseComment(issue.id);
    const reviewMd = this.safeRead(path.join(repoRoot, "agents/review/AGENTS.md")) ?? "";
    const reviewedAgentMd = previousAssigneeName
      ? this.safeRead(path.join(repoRoot, this.agentsMdForName(previousAssigneeName))) ?? ""
      : "";
    const repoMd = this.safeRead(path.join(repoRoot, "AGENTS.md")) ?? "";
    const gateMd = this.safeRead(path.join(repoRoot, "agents/_shared/CEO-REVIEW-GATE.md")) ?? "";

    const systemPrompt = [
      `You are ReviewAgent running review on ${issue.identifier} submitted by ${previousAssigneeName ?? "an agent"}.`,
      `Running on Ollama Cloud model ${model}.`,
      "",
      "## Workflow",
      "1. Read the close comment to learn which files the engineer touched.",
      "2. Read each touched file via read_file, OR run git_diff to see the actual change.",
      "3. Walk the issue body's Acceptance criteria. Verify each item against the diff/files.",
      "4. If the issue mentions tests in Verification, run them via run_test (90s, max 6 runs).",
      "5. If every acceptance item passes, call approve(summary). If ANY item fails, call request_changes(feedback) with a numbered list naming specific files, tests, or acceptance items.",
      "",
      "## Hard rules",
      `- ${MAX_TURNS} turns max. Be efficient.`,
      "- Read-only — you cannot write, edit, or run arbitrary commands. Only approve or request_changes finalize.",
      "- Do not approve a stub test (one that asserts only `expect(X).toBeDefined()` etc.).",
      "- Do not approve a file change that contradicts the engineer's lane in their AGENTS.md.",
      "",
      "## Engineer's role doc (the quality bar this submission must meet)",
      reviewedAgentMd || "(no role AGENTS.md found — proceed cautiously)",
      "",
      "## Repo conventions",
      repoMd || "(no root AGENTS.md found)",
      "",
      "## Review responsibilities",
      reviewMd,
      "",
      "## Close-comment lifecycle",
      gateMd,
    ].join("\n");

    const userPrompt = [
      `# Issue ${issue.identifier} (status=review, assignee=ReviewAgent)\nTitle: ${issue.title}`,
      `Submitted by: ${previousAssigneeName ?? "(unknown)"}`,
      "",
      "## Engineer's close comment (\"Ready for review\")",
      closeComment ? closeComment.body : "(no close comment found — flag this in your verdict)",
      "",
      "## Issue body (contains the acceptance criteria)",
      issue.description,
    ].join("\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const ctx: ReviewContext = { issue, repoRoot, testRuns: 0 };
    let totalIn = 0;
    let totalOut = 0;
    let verdict: { kind: "approve" | "changes"; text: string } | null = null;
    let lastError: string | null = null;
    const toolHist: Record<string, number> = {};
    let turnsUsed = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turnsUsed = turn + 1;
      trace({ event: "turn_start", turn, messages: messages.length });

      let assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

      try {
        if (STREAM_ENABLED) {
          const stream = await this.client.chat.completions.create({
            model,
            messages,
            tools: TOOL_DEFS,
            tool_choice: "auto",
            temperature: 0.2,
            max_tokens: 4000,
            stream: true,
            stream_options: { include_usage: true },
          });
          let content = "";
          const toolCallsAcc: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};
          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              trace({ event: "delta", turn, content: delta.content });
            }
            const tcDeltas = (delta as { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> })?.tool_calls;
            if (tcDeltas) {
              for (const tc of tcDeltas) {
                const idx = typeof tc.index === "number" ? tc.index : 0;
                if (!toolCallsAcc[idx]) {
                  toolCallsAcc[idx] = { id: tc.id ?? "", type: "function", function: { name: tc.function?.name ?? "", arguments: "" } };
                  trace({ event: "tool_call_begin", turn, index: idx, name: tc.function?.name ?? "" });
                }
                if (tc.id) toolCallsAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallsAcc[idx].function.name = tc.function.name;
                if (tc.function?.arguments) {
                  toolCallsAcc[idx].function.arguments += tc.function.arguments;
                }
              }
            }
            if (chunk.usage) usage = chunk.usage;
          }
          const accumulated = Object.values(toolCallsAcc);
          assistantMessage = {
            role: "assistant",
            content: content || null,
            tool_calls: accumulated.length
              ? (accumulated as unknown as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[])
              : undefined,
          } as OpenAI.Chat.Completions.ChatCompletionMessage;
        } else {
          const completion = await this.client.chat.completions.create({
            model, messages, tools: TOOL_DEFS, tool_choice: "auto",
            temperature: 0.2, max_tokens: 4000,
          });
          usage = completion.usage;
          assistantMessage = completion.choices?.[0]?.message ?? null;
        }
      } catch (err) {
        lastError = `LLM call failed turn ${turn}: ${err instanceof Error ? err.message : String(err)}`;
        this.log.error(lastError);
        trace({ event: "llm_error", turn, error: lastError });
        break;
      }

      totalIn += usage?.prompt_tokens ?? 0;
      totalOut += usage?.completion_tokens ?? 0;
      if (!assistantMessage) {
        lastError = "no completion choice";
        break;
      }
      messages.push(assistantMessage);
      trace({
        event: "turn_end",
        turn,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        toolCallCount: assistantMessage.tool_calls?.length ?? 0,
      });

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        messages.push({
          role: "user",
          content: "You produced text without a tool call. Decide now: call approve or request_changes. If you need more evidence, call read_file, git_diff, or run_test first.",
        });
        continue;
      }

      let terminal = false;
      for (const call of toolCalls) {
        if (call.type === "function") {
          const n = call.function.name;
          toolHist[n] = (toolHist[n] ?? 0) + 1;
        }
        trace({ event: "tool_call", turn, name: call.type === "function" ? call.function.name : call.type });
        const result = await this.dispatchTool(call, ctx);
        const resultStr = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        trace({
          event: "tool_result",
          turn,
          name: call.type === "function" ? call.function.name : call.type,
          ok: !resultStr.startsWith("error:"),
          terminal: !!result.terminal,
          preview: resultStr.slice(0, 600),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultStr,
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
        ["## Approved.", "", verdict.text, "", `Reviewer: ollama-cloud-review-adapter (${model}); turns=${turnsUsed} hist=${histStr} tokens=${usage.in}in/${usage.out}out`].join("\n")
      );
      trace({ event: "review_end", outcome: "approve", turns: turnsUsed, tokensIn: usage.in, tokensOut: usage.out });
      this.log.info(`REVIEW approve ${issue.identifier}`, { ...usage, turns: turnsUsed });
      const outcome: AdapterOutcome = {
        status: "completed",
        summary: `ollama-review: ${issue.identifier} approved`,
      };
      if (usage.in) outcome.tokensInput = usage.in;
      if (usage.out) outcome.tokensOutput = usage.out;
      return outcome;
    }

    if (verdict?.kind === "changes") {
      const targetAssignee = previousAssigneeId ?? REVIEW_AGENT_ID; // fallback keeps the ticket visible to ReviewAgent
      this.prependFeedbackToIssueBody(issue.id, verdict.text);
      this.transitionIssue(issue.id, "todo", targetAssignee);
      this.postComment(
        issue.id,
        issue.tenantId,
        [
          "## Changes requested:",
          "",
          verdict.text,
          "",
          "Issue reverted to `todo`; feedback prepended to the issue body so your next attempt sees it inline.",
          `Reviewer: ollama-cloud-review-adapter (${model}); turns=${turnsUsed} hist=${histStr}`,
        ].join("\n")
      );
      if (previousAssigneeId) {
        this.fireWakeup(issue.tenantId, previousAssigneeId, issue.id, "review-changes-requested");
      }
      trace({ event: "review_end", outcome: "changes", turns: turnsUsed, tokensIn: usage.in, tokensOut: usage.out });
      this.log.info(`REVIEW changes ${issue.identifier}`, { ...usage, turns: turnsUsed });
      return { status: "completed", summary: `ollama-review: ${issue.identifier} changes requested` };
    }

    const reason = lastError ?? `max-turns ${MAX_TURNS} hit without verdict`;
    trace({ event: "review_end", outcome: "bail", reason, turns: turnsUsed, tokensIn: usage.in, tokensOut: usage.out });
    this.log.warn(`REVIEW bail ${issue.identifier}: ${reason} | model=${model} turns=${turnsUsed} hist=${histStr}`);
    this.postComment(
      issue.id,
      issue.tenantId,
      ["## Auto-review did not finish", "", `Reason: ${reason}`, `Tool calls: ${histStr || "(none)"}`, "", "Issue stays at `review` for human attention."].join("\n")
    );
    return { status: "failed", error: `ollama-review: ${reason}` };
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
          return { content: await this.toolReadFile(String(args.path ?? ""), ctx) };
        case "list_dir":
          return { content: await this.toolListDir(String(args.path ?? ""), ctx) };
        case "grep":
          return { content: await this.toolGrep(String(args.pattern ?? ""), args.path ? String(args.path) : undefined, ctx) };
        case "git_diff":
          return { content: await this.toolGitDiff(args.ref ? String(args.ref) : undefined, ctx) };
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

  private async toolReadFile(rel: string, ctx: ReviewContext): Promise<string> {
    const abs = this.absInRepo(rel, ctx.repoRoot);
    if (!abs) return `error: invalid path "${rel}"`;
    if (!existsSync(abs)) return `error: file not found: ${rel}`;
    const buf = await fs.readFile(abs);
    if (buf.length > FILE_READ_CAP_BYTES) {
      return `--- ${rel} (truncated to ${FILE_READ_CAP_BYTES}/${buf.length} bytes) ---\n` + buf.subarray(0, FILE_READ_CAP_BYTES).toString("utf8");
    }
    return `--- ${rel} (${buf.length} bytes) ---\n` + buf.toString("utf8");
  }

  private async toolListDir(rel: string, ctx: ReviewContext): Promise<string> {
    const abs = this.absInRepo(rel || ".", ctx.repoRoot);
    if (!abs) return `error: invalid path "${rel}"`;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  }

  private async toolGrep(pattern: string, rel: string | undefined, ctx: ReviewContext): Promise<string> {
    if (!pattern) return "error: pattern required";
    const abs = rel ? this.absInRepo(rel, ctx.repoRoot) : ctx.repoRoot;
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
        const cleaned = out.split("\n").filter(Boolean).slice(0, 100).map((l) => l.replace(ctx.repoRoot + "/", "")).join("\n");
        resolve(cleaned || "(no matches)");
      });
      setTimeout(() => proc.kill("SIGKILL"), 8000);
    });
  }

  private async toolGitDiff(ref: string | undefined, ctx: ReviewContext): Promise<string> {
    return await new Promise((resolve) => {
      const args = ["diff"];
      if (ref) args.push(ref);
      const proc = spawn("/usr/bin/git", args, { cwd: ctx.repoRoot });
      let out = "";
      let bytes = 0;
      const cap = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes < 80_000) out += chunk.toString("utf8");
      };
      proc.stdout.on("data", cap);
      proc.stderr.on("data", cap);
      proc.on("close", () => resolve(out || "(no diff)"));
      setTimeout(() => proc.kill("SIGKILL"), 10_000);
    });
  }

  private async toolRunTest(rel: string, testFile: string | undefined, ctx: ReviewContext): Promise<string> {
    ctx.testRuns++;
    if (ctx.testRuns > 6) return "error: review test-run budget exhausted (6 max)";
    const abs = this.absInRepo(rel, ctx.repoRoot);
    if (!abs) return `error: invalid package_dir "${rel}"`;
    if (!existsSync(abs)) return `error: package_dir not found: ${rel}`;
    return await runSafeTestCommand({ cwd: abs, testFile, timeoutMs: TEST_TIMEOUT_MS });
  }

  private absInRepo(rel: string, repoRoot: string): string | null {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return null;
    if (rel.includes("..")) return null;
    return path.join(repoRoot, rel.replace(/^\.\//, ""));
  }

  private safeRead(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  private agentsMdForName(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z]/g, "");
    const map: Record<string, string> = {
      backendengineer: "agents/backend/AGENTS.md",
      frontendengineer: "agents/frontend/AGENTS.md",
      pythonengineer: "agents/python/AGENTS.md",
      qaengineer: "agents/qa/AGENTS.md",
      techlead: "agents/techlead/AGENTS.md",
      technicalwriter: "agents/writer/AGENTS.md",
      complianceconsultant: "agents/compliance/AGENTS.md",
    };
    return map[slug] ?? "agents/backend/AGENTS.md";
  }

  private loadIssue(id: string): ResolvedIssue | null {
    const row = this.sqlite
      .prepare("SELECT id, identifier, title, description, status, assignee_agent_id, tenant_id, metadata_json FROM execution_issues WHERE id = ?")
      .get(id) as
      | { id: string; identifier: string; title: string; description: string; status: string; assignee_agent_id: string | null; tenant_id: string; metadata_json: string | null }
      | undefined;
    if (!row) return null;
    let metadata: Record<string, unknown> = {};
    if (row.metadata_json) {
      try {
        const parsed = JSON.parse(row.metadata_json);
        if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
      } catch {
        // leave empty
      }
    }
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description ?? "",
      status: row.status,
      assigneeAgentId: row.assignee_agent_id,
      tenantId: row.tenant_id,
      metadata,
    };
  }

  private loadLatestCloseComment(issueId: string): { body: string } | null {
    const row = this.sqlite
      .prepare(
        `SELECT body FROM execution_issue_comments
         WHERE issue_id = ? AND author_label LIKE '%-adapter'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(issueId) as { body: string } | undefined;
    return row ?? null;
  }

  private prependFeedbackToIssueBody(issueId: string, feedback: string): void {
    const row = this.sqlite.prepare("SELECT description FROM execution_issues WHERE id = ?").get(issueId) as { description: string } | undefined;
    const existing = row?.description ?? "";
    const block = [
      "## ⚠ Second pass — CEO requested changes on first submission",
      "",
      "Address these specific items before re-submitting (see also the quality bar in your AGENTS.md):",
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
    const id = "or-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
    const now = new Date().toISOString();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO execution_issue_comments (id, tenant_id, issue_id, author_id, author_label, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, tenantId, issueId, null, "ollama-cloud-review-adapter", body, now);
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
        reason: `ollama-cloud-review: ${reason}`,
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
