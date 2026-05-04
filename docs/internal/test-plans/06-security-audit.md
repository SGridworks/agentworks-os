# Test Plan: Pillar 6 — Security Audit (AgentGuard Scanner)

## Gate
Deliberate-bad CLAUDE.md produces a finding within 60s.

## Verification Criteria

### G1 — Known-bad pattern detection
- [ ] CLAUDE.md containing prompt injection text is detected within 60s
- [ ] Finding has `severity: critical` or `high`
- [ ] Finding `ruleId` maps to the prompt-injection rule

### G2 — All scanner targets
- [ ] CLAUDE.md — detected with `fileType: claude_md`
- [ ] `.cursorrules` — detected with `fileType: cursorrules`
- [ ] MCP config — detected with `fileType: mcp_config`

### G3 — Scanner sidecar resilience
- [ ] Killing scanner-worker mid-scan does not orphan jobs
- [ ] Restarting scanner-worker resumes pending scans
- [ ] No half-written findings after crash
- [ ] No duplicate findings for files already scanned

### G4 — Zero-network isolation
- [ ] Scanner process has no outbound network connections
- [ ] Scanner cannot reach external URLs even if machine is online

### G5 — Adversarial evasion
- [ ] Obfuscated prompt injection detected (base64, rot13, etc.)
- [ ] Large files (10K lines) processed without OOM or hang

## Test Fixtures Required
- `tests/fixtures/scanner/known-bad/CLAUDE-MD-prompt-injection.md`
- `tests/fixtures/scanner/known-bad/cursorrules-bad.yaml`
- `tests/fixtures/scanner/known-bad/mcp-config-leaked-key.yaml`
- `tests/fixtures/scanner/large-10k-lines.md`

## Covered by Existing Tests
- `tests/integration/scanner.test.ts` — 10 tests (schema validation, integration gated on service availability)

## Blocked
- Live integration tests skipped (scanner service not yet running)
- Python test files are empty stubs (0 tests in test_service.py, test_app.py, test_models.py)

## Pass Criteria
All schema tests pass. Live integration tests pass when scanner-worker is running.

## Adversarial Tests
- Base64-encoded prompt injection — should be detected
- File with 10K lines — should complete within 120s
- Scanner killed mid-scan — no orphaned running jobs after restart
