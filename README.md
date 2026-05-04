# AgentWorks OS

The AI compliance firewall for regulated small businesses.

## What it does

Agents (Claude Desktop, Cursor, Codex, ChatGPT via browser extension in v2) connect to AgentWorks OS over a local API. Every action the agent takes passes through a policy engine that checks it against rule packs you configure. Violations are either blocked with a plain‑English explanation or routed to a human approval queue.

The substrate also gives agents persistent memory of your business, a durable system of record for their outputs, and an embedded security scanner that audits agent configurations nightly.

## Who it's for

Regulated SMBs running AI lead‑gen, outreach, or workflow automation—real‑estate brokerages, health‑adjacent services, insurance agencies, financial advisors. Teams where the user of AI isn’t the same person who set it up.

If your lawyer has ever asked “who approved that outbound?” or “how do we prove that message was TCPA‑compliant?”, this is the substrate that lets you answer.

## Quick install

One command on a Mac mini or Linux box you control:

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.1/install.sh | bash
```

Requires Docker Desktop (or Docker Engine on Linux). About 15 minutes on a clean machine.

See the [install runbook](./docs/install-runbook.md) for full step‑by‑step, including prerequisites and first‑run verification.

**Working through an AI coding agent?** Hand the right playbook to Claude Code, Cursor, Codex, etc.:

- [Install Guide](./docs/AI-AGENT-INSTALL-GUIDE.md) — install + vault + MCP, end‑to‑end
- [Rule‑Pack Authoring](./docs/AI-AGENT-RULE-PACK-GUIDE.md) — draft, validate, ship a rule pack safely
- [Operator Runbook](./docs/AI-AGENT-OPERATOR-RUNBOOK.md) — daily ops, triage, incident response
- [MCP Debug](./docs/AI-AGENT-MCP-DEBUG.md) — five‑layer diagnosis when MCP isn't connecting
- [Vault Hygiene](./docs/AI-AGENT-VAULT-HYGIENE.md) — lint, dedupe, prune the vault

## What’s in the box

| Pillar | What it does |
|---|---|
| Memory | Persistent vault that agents read and write. Survives restarts. Seeds from your onboarding answers. |
| Orchestration | Cross‑agent task coordination. One agent can hand off to another with full context. |
| System of record | Append‑only audit log of every action: who did what, when, and the policy decision. |
| Compliance engine | YAML rule packs with allow / block / route‑to‑review outcomes. Ships with TCPA and fair‑housing packs for real estate. |
| Human approval queue | Rule packs can return “route to review.” Approvers see queued actions in the admin UI and approve, reject, or send back. |
| Workflow automation | Bundled n8n with substrate‑aware nodes (memory read/write, policy check, dispatch). |
| Security scanner | AgentGuard scanner runs nightly on your agent configs (CLAUDE.md, .cursorrules, MCP configs). Findings surface as Issues. |
| Compliance evidence report | Monthly PDF summarizing policy decisions, approval‑queue activity, and scanner findings. Signed and hash‑chained. |

## What’s NOT in v1

- Cost metering and per‑agent LLM spend attribution (v1.1)
- Per‑employee SSO (Google Workspace, Entra) (v1.2)
- Browser extension for ChatGPT/Manus (v2)
- Hosted/cloud deployment (local‑only in v1)
- MCP‑first rule‑pack preview (CLI dry‑run is v1 fallback)

See [CHANGELOG.md](./CHANGELOG.md) for full release notes and known issues.

## Architecture

Single daemon (`agentos-d`) with three connection surfaces:
- **REST API** — custom agents and internal tooling
- **MCP server** — Claude Desktop, Cursor, Codex
- **WebSocket** — admin UI, n8n custom nodes

Python `scanner‑worker` as a sidecar. n8n as a sidecar. All data stays on your hardware.

## License

Apache 2.0. See [LICENSE](./LICENSE).

## Getting started

1. [Install](./docs/install-runbook.md)
2. Run the onboarding wizard (starts automatically on first admin UI load)
3. Connect your agents via MCP (wizard walks you through Claude Desktop and Cursor)
4. Load a rule pack or write your own (see [rule‑pack authoring](./docs/rule-pack-authoring.md))
5. Test a policy decision: try to send an outbound SMS to a number in your DNC list and confirm it routes to review.

## Docs

- [Install runbook](./docs/install-runbook.md)
- [Rule‑pack authoring guide](./docs/rule-pack-authoring.md)
- [AWCP v0.1 spec](./docs/awcp.md) — draft spec for the wire format, API surface, and data model
- [Support bundle how‑to](./docs/support-bundle.md)
- [Backup and restore](./docs/backup-restore.md)
- [Update procedure](./docs/update-procedure.md)
