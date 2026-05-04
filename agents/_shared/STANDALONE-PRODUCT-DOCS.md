# AgentWorks Stands Alone (Customer-Facing Docs)

## Rule

Customer-facing documentation describes AgentWorks OS as its own product. Do not reference upstream projects (paperclip, obsidian, Hermes, n8n internals) in customer-facing surfaces. Customers don't care that we built on a substrate; they care that AgentWorks works.

**Why:** operator ruled this 2026-04-27. The internal architecture lineage (paperclip → agentos-d, Obsidian vault → AgentWorks vault, Hermes → orchestrator) leaks if we let it. Customer perception of "thin wrapper around X" tanks the moat. Build the documentation that supports the product positioning.

## What this means in practice

### Customer-facing surfaces (AgentWorks vocabulary only)

- `README.md`
- `docs/install-runbook.md`
- `docs/rule-pack-authoring.md`
- `docs/awcp.md` (and `docs/awcp/`)
- `docs/backup-restore.md`
- `docs/support-bundle.md`
- `docs/update-procedure.md`
- `docs/error-messages.md`
- `docs/onboarding-wizard-copy.md`
- `docs/disclaimer-text.md`
- `docs/required-data-declarations.md`
- the admin UI itself (every label, button, error, tooltip)
- the CLI `agentworks --help` output
- the MCP server's tool descriptions

In any of those, NEVER write: `paperclip`, `obsidian`, `Hermes`, `OpenClaw`, `gstack`, `Hermes vault`, `paperclip API`, `paperclip server`. Use AgentWorks names: `agentos-d`, `AgentWorks API`, `vault` (generic noun is fine), `the substrate`, `the daemon`.

### Internal-only surfaces (architecture lineage allowed)

- `docs/brand-naming-convention.md` — explicitly the mapping doc; paperclip references are the entire point
- `docs/rfc/*.md` — architecture decision records; engineers reading these benefit from the substrate context
- `agents/*/AGENTS.md` — agent role instructions; references to paperclip explain the orchestrator runtime
- `PLAN.md` — internal plan; references the substrate origins
- `HERMES_KICKOFF.md` — internal kickoff prompt
- `kill-criterion-checkpoint.md` — internal CEO tracker

These files MAY reference paperclip / obsidian / Hermes when discussing architecture or origin. They should not be linked from customer-facing surfaces.

### Org-internal labels

Customer-facing docs do not name internal roles ("ComplianceConsultant owns this", "TechLead reviews that"). Replace with neutral phrasing ("see the AgentWorks team" / drop the line) or remove.

## Bibliography / attribution

If license obligations require attribution to upstream Apache-2.0 work (e.g., paperclip core), put it in `ATTRIBUTION.md` at the repo root. That file IS customer-discoverable but it lists license obligations only — not architectural lineage. Keep it terse: project name, copyright, license. Do not editorialize.

## When in doubt

Ask: "Will customer at Example Tenant read this?" If yes, AgentWorks-only vocabulary. If no (architecture log, RFC, internal role file), substrate vocabulary is fine.
