# Test Plan: Pillar 5 — Workflow Automation (n8n)

## Gate
Stock n8n + 3 custom nodes integrated; sample workflow runs end-to-end.

## Verification Criteria

### G1 — n8n bundled and running
- [ ] `docker compose up` brings up n8n service on port 5678
- [ ] n8n UI is accessible at `http://localhost:5678`
- [ ] n8n starts with the bundled custom nodes installed

### G2 — 3 custom nodes available in n8n
- [ ] `agentworks.memory.read` appears in n8n node picker
- [ ] `agentworks.memory.write` appears in n8n node picker
- [ ] `agentworks.policy_check` appears in n8n node picker
- [ ] Each node has the documented input/output ports

### G3 — End-to-end sample workflow
- [ ] Workflow: `agentworks.memory.read` → `agentworks.policy_check` → `agentworks.memory.write`
- [ ] Executes without error
- [ ] Each node passes correct data to the next

### G4 — Real estate lead-enrichment workflow
- [ ] Workflow path: lead enrichment → policy check → outbound action queue
- [ ] Route_to_review decisions correctly route to approval queue
- [ ] Block decisions are logged, action is not dispatched

## Test Fixtures Required
- `tests/fixtures/workflows/real-estate-lead-enrichment.json` — n8n workflow export
- `tests/fixtures/n8n/test-vault/` — seeded test vault content

## Covered by Existing Tests
- `tests/integration/n8n-nodes.test.ts` — schema validation for all 4 nodes, 7 passing schema tests

## Blocked
- Live API integration tests are skipped (require `agentos-d` running)
- n8n service not yet in docker-compose

## Pass Criteria
Schema validation tests pass. Integration tests pass when services are running.

## Adversarial Tests
- n8n service down — verify custom nodes fail gracefully with clear error
- agentos-d unreachable — verify memory nodes return error, not hang
- Malformed JSON in policy_check node — verify it returns error, not crash n8n
