# Risk Watchlist — observed but not acted on

Risks identified during build that we have chosen not to ticket *yet*. Each entry has a re-evaluation trigger. When the trigger fires, open a ticket and move the entry into `LEARNINGS.md`.

## R1 — Model + provider concentration (2026-04-28) — TRIGGERED, ACTING

**Observed (morning).** All 8 AgentWorks agents share one config: `gpt-oss:120b` via `ollama-cloud`. Morning: 41 successes / 7 failures, no rate-limit signals; ollama-cloud reachable in ~110ms.

**Trigger fired (afternoon, 2026-04-28T14:23).** Rolling 1-hour failure rate hit **22.7%** (5 failed / 22 completed). 4 of 5 failures were `adapter_failed` while ollama-cloud `/v1/models` stayed responsive (200 in 127ms). Failures distributed across BackendEng, ComplianceConsultant, TechLead — provider-side shape, not single-agent. Classic capacity-pressure: status endpoints stay responsive, completions throttle.

**Action taken.** Tickets opened for the cheap moves listed below. operator's call on move #3: must be customer-configurable, not a predetermined rotation we hardcode.

- [AWO-169](/AWO/issues/AWO-169) — Per-run LLM usage telemetry (token counts, cost, provider rate-limit headers). Closes the "are we cap-bound" visibility gap.
- [AWO-170](/AWO/issues/AWO-170) — Fallback model in `adapterConfig` with retry. Provider blinks stop being build-blockers.
- [AWO-171](/AWO/issues/AWO-171) — Customer-configurable per-role model selection. **Backlog.** Open work only after AWO-169 ships + 2 weeks of usage data + visible model-fit failure pattern.

**Originally listed cheap moves (preserved for context):**
1. Add a per-agent fallback model in `adapterConfig` — primary `gpt-oss:120b/ollama-cloud`, fallback `gemma3:12b` on mini1 Ollama. Provider blink stops being full outage.
2. Populate per-run `usageJson` (token counts, cost) so cap-approach is visible before it bites.
3. Rotate models per role — *deferred and customer-scoped per operator's call. Move 3 lives in AWO-171 backlog.*

**Re-evaluation triggers that fired:** failure rate >20% rolling 1-hour. Other triggers (sustained outage, install date <2 weeks) remain set; if any fires again before AWO-169/170 land, escalate priority.
