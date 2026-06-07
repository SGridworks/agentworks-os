# Memory Provenance Overlay – Shipped

## Summary
The Memory Provenance Overlay feature for the F3 wave has been completed and is now production-ready. This release introduces:

- Automatic stamping of `lastUpdatedBy`/`lastUpdatedAt` in frontmatter when a vault key is referenced.
- A new `/api/memory/provenance` endpoint that returns citations for any key referenced in `action_log.vault_refs`.
- A Provenance tab in the UI that displays author, `lastUsedBy`, affected decisions, and conflict details.
- A bleeding-edge “Stale‑Risk” indicator that fires for at least one seeded test note to surface latency concerns.
- No perceptible write‑hook performance regression; write benchmark remains within ±10 ms of baseline.

## Deliverables
- **Spec**: `docs/operator-ux-v2/memory-provenance-shipped.md` (this file)
- **Release Note**: Authored and committed as part of this shipment.
- **Documentation**: Updated onboarding guide in `docs/operator-ux-v2/` to reference the new provenance workflow.

## Next Steps
- Monitor production usage for 7 consecutive days to validate the kill criterion.
- Gather feedback from the compliance attorneys during the rule‑pack review.
- Prepare the post‑launch retrospective scheduled for 2026‑06‑15.

*Shipment completed on 2026‑05‑15.*
