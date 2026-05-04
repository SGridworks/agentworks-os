# Smoke Install Test Plan (AWO-112)

**Goal**: Verify that a clean Mac mini can install AgentWorks end‑to‑end within 15 minutes, that the installer completes all gates, and that the kill‑switch can abort safely.

## Preconditions
- Fresh macOS (Intel/Apple Silicon) VM or physical Mac mini.
- No prior `agentworks` installation.
- Network allows outbound HTTPS to our CDNs and Docker Hub.
- `git` and `pnpm` installed.

## Steps
1. Clone repo:
   ```bash
   git clone https://github.com/agentworks/agentworks-os.git
   cd agentworks-os
   ```
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Run dry‑run installer (timeout 15 min):
   ```bash
   time pnpm run install --dry-run
   ```
4. Verify output contains:
   - `Installation complete`
   - All health checks passed.
   - No error messages.
5. Simulate kill‑switch mid‑install:
   - In a separate terminal, start `pnpm run install`.
   - After 30 s, send SIGINT (Ctrl‑C) and ensure graceful shutdown log appears.
6. Post‑install validation:
   - Run `agentworks status` – should report `ready`.
   - Verify `agentworks version` matches `package.json`.
   - Confirm no leftover temp files in `~/.agentworks`.

## Acceptance Criteria
- Full install finishes < 15 min on a clean system.
- All gates (network, disk, Docker) pass.
- Kill‑switch stops the installer without corrupting state.
- No residual processes remain.
- Test suite reports **0 failures**.

## Adversarial Test
- Modify network to drop packets after 5 seconds; installer must timeout and rollback cleanly.

## Reporting
- Record `time` output, log snapshots, and status checks.
- Attach logs as a comment on AWO‑112.
