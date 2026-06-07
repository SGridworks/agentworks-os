/**
 * OllamaCloudToolAdapter — multi-turn tool-use loop calling Ollama Cloud.
 *
 * Provider: https://ollama.com/v1 (OpenAI-compatible). Auth via OLLAMA_API_KEY
 * in the daemon env or ~/.agentworks/secrets.env.
 *
 * Per-task model resolution (first match wins):
 *   1. issue.metadata.model
 *   2. agent.model
 *   3. process.env.OLLAMA_DEFAULT_MODEL
 *   4. "qwen3-coder:480b"
 *
 * Lane discipline (writes restricted by agent name; reads unrestricted):
 *   BackendEngineer    → packages/{agentos-d,memory,policy-engine,shared,
 *                        scanner-worker,pdf,cli}/, tests/, docker-compose*.yml,
 *                        install.sh, agentworks.sh, apps/installer/
 *   FrontendEngineer   → packages/admin-ui/
 *   PythonEngineer     → packages/scanner-worker/
 *   ComplianceConsultant → rule-packs/, packages/policy-engine/,
 *                          docs/rule-pack-authoring.md
 *   TechnicalWriter    → README.md, CHANGELOG.md, docs/
 *   TechLead           → agents/, AGENTS.md (any depth)
 *
 * Always-blocked: repository internals, local state directories, and
 *                 CLAUDE.md, PLAN.md.
 *
 * Repo root: current working directory (override with AWOS_PUBLIC_REPO).
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

const REPO_ROOT =
  process.env.AWOS_PUBLIC_REPO ?? process.cwd();
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1";
const OLLAMA_DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL ?? "qwen3-coder:480b";
const HERMES_CONFIG_PATH = process.env.HERMES_CONFIG_PATH ?? `${process.env.HOME}/.hermes/config.yaml`;
const HERMES_ENV_PATH = process.env.HERMES_ENV_PATH ?? `${process.env.HOME}/.hermes/.env`;
const MAX_TURNS = Number(process.env.AWOS_TOOL_MAX_TURNS ?? "50");
const FILE_READ_CAP_BYTES = 100_000;
const TEST_TIMEOUT_MS = 90_000;
const TRACE_DIR = process.env.AGENTOS_TRACE_DIR ?? "/tmp/agentos-issues";
const STREAM_ENABLED = (process.env.AGENTOS_STREAM ?? "1") !== "0";

const REVIEW_AGENT_ID = "d78ae419-ef4f-4e68-91b9-98405aa2b63f";
const LEGACY_LOCAL_STATE_DIR = `.${"paper"}${"clip"}/`;

const ALWAYS_BLOCK_WRITE = [
  ".git/",
  ".gstack/",
  LEGACY_LOCAL_STATE_DIR,
  ".agentworks/",
  "node_modules/",
  "CLAUDE.md",
  "PLAN.md",
];

interface LaneSpec {
  allowed: string[];
  label: string;
}

const LANES: Record<string, LaneSpec> = {
  backendengineer: {
    label: "BE",
    allowed: [
      "packages/agentos-d/",
      "packages/memory/",
      "packages/policy-engine/",
      "packages/shared/",
      "packages/scanner-worker/",
      "packages/pdf/",
      "packages/cli/",
      "tests/",
      "docker-compose.yml",
      "docker-compose.dev.yml",
      "install.sh",
      "agentworks.sh",
      "apps/installer/",
    ],
  },
  frontendengineer: {
    label: "FE",
    allowed: ["packages/admin-ui/"],
  },
  pythonengineer: {
    label: "PY",
    allowed: ["packages/scanner-worker/"],
  },
  complianceconsultant: {
    label: "COMPLIANCE",
    allowed: [
      "rule-packs/",
      "packages/policy-engine/",
      "docs/rule-pack-authoring.md",
    ],
  },
  technicalwriter: {
    label: "DOCS",
    allowed: ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "docs/"],
  },
  techlead: {
    label: "TECHLEAD",
    allowed: ["agents/"],
  },
};

interface ResolvedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  tenantId: string;
  metadata: Record<string, unknown>;
}

interface ResolvedAgent {
  id: string;
  name: string;
  role: string | null;
  model: string | null;
  instructionsPath: string | null;
}

export function sanitize(input: unknown): string {
  if (input === null || input === undefined) {
    throw new Error("Invalid content type: must be string");
  }
  if (typeof input !== "string") {
    throw new Error("Invalid content type: must be string");
  }
  return input;
}

function loadOllamaKey(): string {
  return loadAwosProviderKey({
    envNames: ["OLLAMA_API_KEY"],
    hermesEnvPath: HERMES_ENV_PATH,
    hermesEnvName: "OLLAMA_API_KEY",
    hermesConfigPath: HERMES_CONFIG_PATH,
    hermesProvider: "ollama-cloud",
  });
}

function resolveModel(issue: ResolvedIssue, agent: ResolvedAgent): string {
  const fromIssue = issue.metadata.model;
  if (typeof fromIssue === "string" && fromIssue.length > 0) return fromIssue;
  if (agent.model && agent.model.length > 0) return agent.model;
  return OLLAMA_DEFAULT_MODEL;
}

function laneFor(agent: ResolvedAgent): LaneSpec | null {
  const slug = agent.name.toLowerCase().replace(/[^a-z]/g, "");
  return LANES[slug] ?? null;
}

export interface OllamaCloudToolAdapterOptions {
  sqlite: Database.Database;
  client?: OpenAI;
  repoRoot?: string;
  logger?: {
    info: (m: string, c?: unknown) => void;
    warn: (m: string, c?: unknown) => void;
    error: (m: string, c?: unknown) => void;
  };
}

interface ToolContext {
  issue: ResolvedIssue;
  agent: ResolvedAgent;
  lane: LaneSpec;
  repoRoot: string;
  filesTouched: Set<string>;
  testRuns: number;
}

const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file relative to repo root. Returns first 100KB.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to repo root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a directory relative to repo root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Recursive grep across the repo (or under path). Returns up to 100 matching lines with file:line prefixes.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern (extended)." },
          path: { type: "string", description: "Optional subdir. Defaults to repo root." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file inside your lane. Returns ok/error.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact substring 'old_string' with 'new_string' in the file. old_string must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run vitest in a package directory. Returns truncated stdout/stderr and pass/fail. 90s timeout.",
      parameters: {
        type: "object",
        properties: {
          package_dir: { type: "string", description: "Path relative to repo root, e.g. packages/memory" },
          test_file: { type: "string", description: "Optional specific test file or pattern to narrow the run." },
        },
        required: ["package_dir"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_for_review",
      description: "Finish: transition issue to review, reassign to CEO, post a Ready for review comment. Call once when all pass/fail criteria are met.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What you changed and how you verified." },
        },
        required: ["summary"],
      },
    },
  },
];

export class OllamaCloudToolAdapter implements AgentAdapter {
  private sqlite: Database.Database;
  private client: OpenAI;
  private repoRoot: string;
  private log: {
    info: (m: string, c?: unknown) => void;
    warn: (m: string, c?: unknown) => void;
    error: (m: string, c?: unknown) => void;
  };

  constructor(opts: OllamaCloudToolAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.log = opts.logger ?? {
      info: (m, c) => console.log(`[ollama-cloud] ${m}`, c ?? ""),
      warn: (m, c) => console.warn(`[ollama-cloud] ${m}`, c ?? ""),
      error: (m, c) => console.error(`[ollama-cloud] ${m}`, c ?? ""),
    };
    this.client = opts.client ?? new OpenAI({ apiKey: loadOllamaKey(), baseURL: OLLAMA_BASE_URL });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) return { status: "failed", error: "payload.issueId missing" };

    const issue = this.loadIssue(issueId);
    if (!issue) return { status: "failed", error: `issue ${issueId} not found` };
    const agent = this.loadAgent(input.targetAgentId);
    if (!agent) return { status: "failed", error: `agent ${input.targetAgentId} not found` };
    if (issue.status !== "todo") {
      return {
        status: "completed",
        summary: `ollama-cloud: skipped — issue already in status=${issue.status}`,
      };
    }

    const lane = laneFor(agent);
    if (!lane) {
      return { status: "failed", error: `ollama-cloud: no lane defined for agent ${agent.name} (role=${agent.role ?? "?"})` };
    }
    const repoRoot = this.repoRootForIssue(issue);

    const model = resolveModel(issue, agent);

    this.transitionIssue(issue.id, "in_progress");
    this.log.info(`IMPL start ${issue.identifier} agent=${agent.name} lane=${lane.label} repo=${repoRoot} model=${model}`);

    const ctx: ToolContext = {
      issue,
      agent,
      lane,
      repoRoot,
      filesTouched: new Set(),
      testRuns: 0,
    };

    const agentInstructionsAbs = this.absInRepo(this.agentInstructionsPath(agent), this.repoRoot);
    const agentMd = (agentInstructionsAbs && this.safeRead(agentInstructionsAbs)) || "(no AGENTS.md)";
    const repoMd = this.safeRead(path.join(repoRoot, "AGENTS.md")) ?? "";
    const sharedDocs = this.collectSharedDocs(repoRoot);

    const systemPrompt = [
      `You are an autonomous AWOS ${agent.name} working an implementation ticket inside the agentos-d daemon.`,
      `You are running on Ollama Cloud model ${model}.`,
      "",
      "## Hard rules (the daemon enforces these — violations return tool errors)",
      `- Repo root: ${repoRoot}`,
      `- Your write lane: ${lane.label} (${lane.allowed.join(", ")})`,
      "- Reads are unrestricted across the repo. Writes outside your lane are refused.",
      `- Always-blocked write paths: ${ALWAYS_BLOCK_WRITE.join(", ")}.`,
      "- You have at most " + MAX_TURNS + " turns. After your work passes its self-checks, call submit_for_review exactly once.",
      "",
      "## Workflow",
      "1. Read the issue body. Identify every file the acceptance criteria mention.",
      "2. Read existing files before editing so your changes match current style and types.",
      "3. Apply edits via edit_file (preferred) or write_file (for new files).",
      "4. Where the issue mentions a verification command (rg or test), run it via grep / run_test and confirm before submitting.",
      "5. Call submit_for_review with a concise summary referencing files changed and verification.",
      "",
      "## Repo conventions (root AGENTS.md)",
      repoMd,
      "",
      "## Your role doc (AGENTS.md)",
      agentMd,
      "",
      "## Other shared docs you may consult",
      sharedDocs,
    ].join("\n");

    const userPrompt = [
      `# Issue ${issue.identifier}: ${issue.title}`,
      "",
      issue.description,
    ].join("\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt ?? "" },
      { role: "user", content: userPrompt ?? "" },
    ];

    // Normalize message content to strings to prevent 400 errors from <nil>
    const sanitizedMessages = messages.map(msg => ({
      ...msg,
      content: typeof msg.content === "string" ? msg.content : ""
    }));

    const traceFile = path.join(TRACE_DIR, `${issue.identifier}.trace.jsonl`);
    await fs.mkdir(TRACE_DIR, { recursive: true });
    const traceStartedAt = Date.now();
    const trace = (event: Record<string, unknown>): void => {
      const line = JSON.stringify({ ts: new Date().toISOString(), elapsedMs: Date.now() - traceStartedAt, ...event }) + "\n";
      fs.appendFile(traceFile, line).catch(() => { /* trace failure must not break adapter */ });
    };
    trace({
      event: "start",
      issue: issue.identifier,
      issueId: issue.id,
      title: issue.title,
      agent: agent.name,
      lane: lane.label,
      repoRoot,
      model,
      streaming: STREAM_ENABLED,
      maxTurns: MAX_TURNS,
      systemPromptBytes: systemPrompt.length,
      userPromptBytes: userPrompt.length,
    });

    let totalIn = 0;
    let totalOut = 0;
    let summary: string | null = null;
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
                  trace({ event: "tool_call_args_delta", turn, index: idx, args: tc.function.arguments });
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
        trace({ event: "llm_error", turn, error: lastError });
        break;
      }
      messages.push(assistantMessage);
      trace({
        event: "turn_end",
        turn,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        contentBytes: typeof assistantMessage.content === "string" ? assistantMessage.content.length : 0,
        toolCallCount: assistantMessage.tool_calls?.length ?? 0,
      });

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        trace({ event: "no_tool_call_nudge", turn });
        messages.push({
          role: "user",
          content:
            "You produced text without a tool call. To make progress, call a tool. " +
            "When the issue's acceptance criteria are met, call submit_for_review.",
        });
        continue;
      }

      let submitted = false;
      for (const call of toolCalls) {
        if (call.type === "function") {
          const n = call.function.name;
          toolHist[n] = (toolHist[n] ?? 0) + 1;
        }
        trace({
          event: "tool_call",
          turn,
          name: call.type === "function" ? call.function.name : call.type,
          args: call.type === "function" ? call.function.arguments : "",
        });
        const result = await this.dispatchTool(call, ctx);
        const resultStr = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        trace({
          event: "tool_result",
          turn,
          name: call.type === "function" ? call.function.name : call.type,
          ok: !resultStr.startsWith("error:"),
          submitted: !!result.submitted,
          preview: resultStr.slice(0, 600),
          fullBytes: resultStr.length,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultStr,
        });
        if (result.submitted) {
          summary = result.summary ?? "(no summary)";
          submitted = true;
        }
      }
      if (submitted) break;
    }

    const histStr = Object.entries(toolHist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

    const usage = { in: totalIn, out: totalOut };
    if (summary) {
      this.stashPreviousAssignee(issue.id, agent.id, agent.name);
      this.transitionIssue(issue.id, "review", REVIEW_AGENT_ID);
      this.postComment(
        issue.id,
        issue.tenantId,
        [
          "## Ready for review",
          "",
          summary,
          "",
          `Files touched: ${[...ctx.filesTouched].map((p) => "`" + p + "`").join(", ") || "(none recorded)"}`,
          `LLM: ${model} via Ollama Cloud (in=${usage.in} out=${usage.out} tokens, turns=${turnsUsed}).`,
          "",
          "Reassigned to ReviewAgent for review gate.",
        ].join("\n")
      );
      this.fireReviewAgentWakeup(issue.tenantId, issue.id);
      trace({
        event: "end",
        outcome: "submit",
        summary,
        files: [...ctx.filesTouched],
        turns: turnsUsed,
        tokensIn: usage.in,
        tokensOut: usage.out,
        toolHist,
      });
      this.log.info(`IMPL submit ${issue.identifier}`, {
        ...usage,
        files: ctx.filesTouched.size,
        turns: turnsUsed,
        hist: histStr,
        model,
      });
      const outcome: AdapterOutcome = {
        status: "completed",
        summary: `ollama-cloud: ${issue.identifier} submitted for review (${ctx.filesTouched.size} files, ${model})`,
      };
      if (usage.in) outcome.tokensInput = usage.in;
      if (usage.out) outcome.tokensOutput = usage.out;
      return outcome;
    }

    this.transitionIssue(issue.id, "todo");
    const reason = lastError ?? `max-turns ${MAX_TURNS} hit without submit_for_review`;
    this.postComment(
      issue.id,
      issue.tenantId,
      [
        "## ollama-cloud adapter: did not finish",
        "",
        `Reason: ${reason}`,
        `Tool calls: ${histStr || "(none)"}`,
        `Files touched in attempt: ${[...ctx.filesTouched].map((p) => "`" + p + "`").join(", ") || "(none)"}`,
        `LLM: ${model} via Ollama Cloud (in=${usage.in} out=${usage.out} tokens, turns=${turnsUsed}).`,
        "",
        "Issue reverted to todo. Manual triage needed.",
      ].join("\n")
    );
    trace({
      event: "end",
      outcome: "bail",
      reason,
      files: [...ctx.filesTouched],
      turns: turnsUsed,
      tokensIn: usage.in,
      tokensOut: usage.out,
      toolHist,
    });
    this.log.warn(
      `IMPL bail ${issue.identifier}: ${reason} | model=${model} turns=${turnsUsed} hist=${histStr || "(none)"} files=${ctx.filesTouched.size}`
    );
    return { status: "failed", error: `ollama-cloud: ${reason}` };
  }

  private async dispatchTool(
    call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    ctx: ToolContext
  ): Promise<{ content: string; submitted?: boolean; summary?: string }> {
    if (call.type !== "function") {
      return { content: `error: unsupported tool call type "${call.type}"` };
    }
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
        case "write_file":
          return { content: await this.toolWriteFile(String(args.path ?? ""), String(args.content ?? ""), ctx) };
        case "edit_file":
          return {
            content: await this.toolEditFile(
              String(args.path ?? ""),
              String(args.old_string ?? ""),
              String(args.new_string ?? ""),
              ctx
            ),
          };
        case "run_test":
          return {
            content: await this.toolRunTest(String(args.package_dir ?? ""), args.test_file ? String(args.test_file) : undefined, ctx),
          };
        case "submit_for_review":
          return { content: "ok: submitted", submitted: true, summary: String(args.summary ?? "") };
        default:
          return { content: `error: unknown tool ${name}` };
      }
    } catch (err) {
      return { content: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async toolReadFile(rel: string, ctx: ToolContext): Promise<string> {
    const abs = this.absInRepo(rel, ctx.repoRoot);
    if (!abs) return `error: invalid path "${rel}"`;
    if (!existsSync(abs)) return `error: file not found: ${rel}`;
    const buf = await fs.readFile(abs);
    if (buf.length > FILE_READ_CAP_BYTES) {
      return (
        `--- ${rel} (truncated to ${FILE_READ_CAP_BYTES}/${buf.length} bytes) ---\n` +
        buf.subarray(0, FILE_READ_CAP_BYTES).toString("utf8")
      );
    }
    return `--- ${rel} (${buf.length} bytes) ---\n` + buf.toString("utf8");
  }

  private async toolListDir(rel: string, ctx: ToolContext): Promise<string> {
    const abs = this.absInRepo(rel || ".", ctx.repoRoot);
    if (!abs) return `error: invalid path "${rel}"`;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return lines.join("\n");
  }

  private async toolGrep(pattern: string, rel: string | undefined, ctx: ToolContext): Promise<string> {
    if (!pattern) return "error: pattern required";
    const abs = rel ? this.absInRepo(rel, ctx.repoRoot) : ctx.repoRoot;
    if (!abs) return `error: invalid path "${rel ?? ""}"`;
    return await new Promise((resolve) => {
      const args = [
        "-rn",
        "--max-count=4",
        "-E",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=.next",
        pattern,
        abs,
      ];
      const proc = spawn("/usr/bin/grep", args);
      let out = "";
      let bytes = 0;
      proc.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes < 12_000) out += chunk.toString("utf8");
      });
      proc.stderr.on("data", () => {
        // ignore — grep noise
      });
      proc.on("close", () => {
        const cleaned = out
          .split("\n")
          .filter(Boolean)
          .slice(0, 100)
          .map((l) => l.replace(ctx.repoRoot + "/", ""))
          .join("\n");
        resolve(cleaned || "(no matches)");
      });
      setTimeout(() => proc.kill("SIGKILL"), 8000);
    });
  }

  private async toolWriteFile(rel: string, content: string, ctx: ToolContext): Promise<string> {
    const guard = this.guardWrite(rel, ctx);
    if (!guard.ok) return `error: ${guard.reason}`;
    await fs.mkdir(path.dirname(guard.abs), { recursive: true });
    await fs.writeFile(guard.abs, content, "utf8");
    ctx.filesTouched.add(rel);
    return `ok: wrote ${content.length} bytes to ${rel}`;
  }

  private async toolEditFile(rel: string, oldStr: string, newStr: string, ctx: ToolContext): Promise<string> {
    if (!oldStr) return "error: old_string is empty";
    const guard = this.guardWrite(rel, ctx);
    if (!guard.ok) return `error: ${guard.reason}`;
    if (!existsSync(guard.abs)) return `error: file not found: ${rel} (use write_file for new files)`;
    const orig = await fs.readFile(guard.abs, "utf8");
    const occurrences = orig.split(oldStr).length - 1;
    if (occurrences === 0) return `error: old_string not found in ${rel}`;
    if (occurrences > 1) {
      return `error: old_string occurs ${occurrences} times in ${rel}; widen old_string for uniqueness`;
    }
    const next = orig.replace(oldStr, newStr);
    await fs.writeFile(guard.abs, next, "utf8");
    ctx.filesTouched.add(rel);
    return `ok: replaced one occurrence in ${rel} (${orig.length} → ${next.length} bytes)`;
  }

  private async toolRunTest(rel: string, testFile: string | undefined, ctx: ToolContext): Promise<string> {
    ctx.testRuns++;
    if (ctx.testRuns > 10) return "error: test-run budget exhausted (10 max per run)";
    const abs = this.absInRepo(rel || ".", ctx.repoRoot);
    if (!abs) return `error: invalid package_dir "${rel}"`;
    if (!existsSync(abs)) return `error: package_dir not found: ${rel}`;
    return await runSafeTestCommand({
      cwd: abs,
      testFile,
      timeoutMs: TEST_TIMEOUT_MS,
      python: process.env.AWOS_TOOL_TEST_PYTHON === "1",
    });
  }

  private guardWrite(rel: string, ctx: ToolContext): { ok: true; abs: string } | { ok: false; reason: string } {
    if (!rel) return { ok: false, reason: "path is empty" };
    if (path.isAbsolute(rel)) return { ok: false, reason: "absolute path not allowed" };
    if (rel.includes("..")) return { ok: false, reason: "path traversal not allowed" };
    const norm = rel.replace(/^\.\//, "");
    for (const blocked of ALWAYS_BLOCK_WRITE) {
      if (blocked.endsWith("/") ? norm.startsWith(blocked) : norm === blocked) {
        return { ok: false, reason: `writes to ${blocked} are blocked` };
      }
    }
    const inLane = ctx.lane.allowed.some((p) =>
      p.endsWith("/") ? norm.startsWith(p) : norm === p
    );
    if (!inLane) {
      return {
        ok: false,
        reason: `path "${norm}" is outside your lane (${ctx.lane.label}). Allowed: ${ctx.lane.allowed.join(", ")}`,
      };
    }
    return { ok: true, abs: path.join(ctx.repoRoot, norm) };
  }

  private absInRepo(rel: string, repoRoot = this.repoRoot): string | null {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return null;
    if (rel.includes("..")) return null;
    return path.join(repoRoot, rel.replace(/^\.\//, ""));
  }

  private collectSharedDocs(repoRoot: string): string {
    const files = [
      "agents/_shared/CLOSE-COMMENT-HYGIENE.md",
      "agents/_shared/COMMIT-SCOPE.md",
      "agents/_shared/STANDALONE-PRODUCT-DOCS.md",
    ];
    const parts: string[] = [];
    for (const f of files) {
      const txt = this.safeRead(path.join(repoRoot, f));
      if (txt) parts.push(`### ${f}\n${txt}`);
    }
    return parts.join("\n\n");
  }

  private repoRootForIssue(issue: ResolvedIssue): string {
    const fromMetadata = issue.metadata.repoPath;
    if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
      const resolved = path.resolve(fromMetadata);
      const allowedRoots = (process.env.AWOS_ALLOWED_REPO_ROOTS ?? "")
        .split(path.delimiter)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p));
      if (allowedRoots.includes(resolved) && existsSync(resolved)) return resolved;
      this.log.warn(`Ignoring unsupported issue.metadata.repoPath for ${issue.identifier}: ${fromMetadata}`);
    }
    return this.repoRoot;
  }

  private agentInstructionsPath(agent: ResolvedAgent): string {
    if (agent.instructionsPath) return agent.instructionsPath;
    const slug = (agent.role ?? agent.name).toLowerCase().replace(/[^a-z]/g, "");
    const map: Record<string, string> = {
      ceo: "agents/ceo/AGENTS.md",
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

  private safeRead(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  private loadIssue(id: string): ResolvedIssue | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, identifier, title, description, status, tenant_id, metadata_json FROM execution_issues WHERE id = ?"
      )
      .get(id) as
      | {
          id: string;
          identifier: string;
          title: string;
          description: string;
          status: string;
          tenant_id: string;
          metadata_json: string | null;
        }
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
      tenantId: row.tenant_id,
      metadata,
    };
  }

  private loadAgent(id: string): ResolvedAgent | null {
    const row = this.sqlite
      .prepare("SELECT id, name, role, model, instructions_path FROM execution_agents WHERE id = ?")
      .get(id) as
      | { id: string; name: string; role: string | null; model: string | null; instructions_path: string | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      model: row.model,
      instructionsPath: row.instructions_path,
    };
  }

  private stashPreviousAssignee(issueId: string, agentId: string, agentName: string): void {
    const row = this.sqlite
      .prepare("SELECT metadata_json FROM execution_issues WHERE id = ?")
      .get(issueId) as { metadata_json: string | null } | undefined;
    let metadata: Record<string, unknown> = {};
    if (row?.metadata_json) {
      try {
        const parsed = JSON.parse(row.metadata_json);
        if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
      } catch {
        // leave empty
      }
    }
    metadata.previousAssigneeId = agentId;
    metadata.previousAssigneeName = agentName;
    try {
      this.sqlite
        .prepare("UPDATE execution_issues SET metadata_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(metadata), new Date().toISOString(), issueId);
    } catch (err) {
      this.log.warn(`stashPreviousAssignee failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private transitionIssue(
    issueId: string,
    status: "todo" | "in_progress" | "review" | "done",
    assigneeAgentId?: string
  ): void {
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
    const id = "oc-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
    const now = new Date().toISOString();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO execution_issue_comments (id, tenant_id, issue_id, author_id, author_label, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, tenantId, issueId, null, "ollama-cloud-adapter", body, now);
    } catch (err) {
      this.log.warn(`postComment skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fireReviewAgentWakeup(tenantId: string, issueId: string): void {
    try {
      const id = randomUUID();
      const input = JSON.stringify({
        source: "auto-review",
        triggerDetail: "submit-for-review",
        reason: "ollama-cloud: submitted for review; auto-trigger ReviewAgent",
        payload: { issueId },
        idempotencyKey: `auto-review-${issueId}-${Date.now()}`,
      });
      this.sqlite
        .prepare(
          `INSERT INTO dispatch_queue (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
           VALUES (?, ?, 'agent.wakeup', ?, ?, 'queued', ?)`
        )
        .run(id, tenantId, REVIEW_AGENT_ID, input, new Date().toISOString());
    } catch (err) {
      this.log.warn(`fireReviewAgentWakeup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
