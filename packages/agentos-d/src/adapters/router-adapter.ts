/**
 * RouterAdapter — picks which underlying adapter handles each dispatch.
 *
 * Routing is agent-role-driven (semantic), not title-driven.
 *
 *   role=review:
 *     status=review              → review adapter   (ollama if adapter_type=ollama_cloud, else kimi)
 *
 *   role=ceo:
 *     title=[CEO] Spec           → spec adapter     (one-shot markdown)
 *     title=[CEO] GATE           → defer            (children must finish first)
 *     anything else              → fail loud        (CEO does not run IMPL or routine review)
 *
 *   role=engineer:
 *                                → tool adapter    (ollama if adapter_type=ollama_cloud, else kimi)
 *
 *   other roles (researcher / qa / general):
 *     fall back to title-prefix routing for backwards compatibility
 */
import type Database from "better-sqlite3";
import type { AgentAdapter, AdapterInput, AdapterOutcome } from "../services/dispatch-consumer.js";
import { KimiAdapter } from "./kimi-adapter.js";
import { KimiToolAdapter } from "./kimi-tool-adapter.js";
import { KimiReviewAdapter } from "./kimi-review-adapter.js";
import { OllamaCloudToolAdapter } from "./ollama-cloud-tool-adapter.js";
import { OllamaCloudReviewAdapter } from "./ollama-cloud-review-adapter.js";

export interface RouterAdapterOptions {
  sqlite: Database.Database;
}

export class RouterAdapter implements AgentAdapter {
  private spec: KimiAdapter;
  private tool: KimiToolAdapter;
  private review: KimiReviewAdapter;
  private ollamaTool: OllamaCloudToolAdapter;
  private ollamaReview: OllamaCloudReviewAdapter;
  private sqlite: Database.Database;

  constructor(opts: RouterAdapterOptions) {
    this.sqlite = opts.sqlite;
    this.spec = new KimiAdapter({ sqlite: opts.sqlite });
    this.tool = new KimiToolAdapter({ sqlite: opts.sqlite });
    this.review = new KimiReviewAdapter({ sqlite: opts.sqlite });
    this.ollamaTool = new OllamaCloudToolAdapter({ sqlite: opts.sqlite });
    this.ollamaReview = new OllamaCloudReviewAdapter({ sqlite: opts.sqlite });
  }

  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const root = input.payload as { issueId?: string; payload?: { issueId?: string } } | undefined;
    const issueId = root?.payload?.issueId ?? root?.issueId;
    if (!issueId) return { status: "failed", error: "router: payload.issueId missing" };

    const issue = this.sqlite
      .prepare("SELECT title, status, assignee_agent_id FROM execution_issues WHERE id = ?")
      .get(issueId) as { title: string; status: string; assignee_agent_id: string | null } | undefined;
    if (!issue) return { status: "failed", error: `router: issue ${issueId} not found` };

    // Use the dispatched agent (who is actually being asked to do this run).
    // In normal flow this equals issue.assignee_agent_id; manual wakes can override.
    const agentId = input.targetAgentId ?? issue.assignee_agent_id;
    const agent = this.sqlite
      .prepare("SELECT role, adapter_type FROM execution_agents WHERE id = ?")
      .get(agentId) as { role: string | null; adapter_type: string | null } | undefined;

    const role = agent?.role ?? null;
    const isOllama = agent?.adapter_type === "ollama_cloud";
    const t = issue.title;

    // Review agents own routine review work.
    if (role === "review") {
      if (issue.status === "review") {
        return isOllama ? this.ollamaReview.run(input) : this.review.run(input);
      }
      return {
        status: "failed",
        error: `router: ReviewAgent only runs review tickets, got status=${issue.status}`,
      };
    }

    // CEO agents never hit IMPL/tool adapters. They spec or defer.
    if (role === "ceo") {
      if (t.startsWith("[CEO] Spec")) return this.spec.run(input);
      if (t.startsWith("[CEO] GATE")) {
        return {
          status: "failed",
          error: "router: GATE issues require all child impl issues done; defer until then.",
        };
      }
      return {
        status: "failed",
        error: `router: CEO cannot run routine ticket "${t.slice(0, 60)}…" — assign review to ReviewAgent or implementation to an engineer`,
      };
    }

    // Engineer agents always go to the tool adapter, picked by adapter_type.
    if (role === "engineer") {
      return isOllama ? this.ollamaTool.run(input) : this.tool.run(input);
    }

    // Backwards-compat for non-engineer / non-ceo roles: route by title prefix.
    if (t.startsWith("[CEO] Spec")) return this.spec.run(input);
    if (
      t.startsWith("[BackendEngineer]") ||
      t.startsWith("[FrontendEngineer]") ||
      t.startsWith("[PythonEngineer]")
    ) {
      return isOllama ? this.ollamaTool.run(input) : this.tool.run(input);
    }
    if (t.startsWith("[CEO] GATE")) {
      return {
        status: "failed",
        error: "router: GATE issues require all child impl issues done; defer until then.",
      };
    }

    return {
      status: "failed",
      error: `router: no adapter for role "${role ?? "null"}" + title "${t.slice(0, 40)}…"`,
    };
  }
}
