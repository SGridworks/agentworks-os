# Sgridworks Managed-Service Tier — Playbook

## Overview

AgentWorks OS is local-first software. Customers deploy it on their own hardware (Mac mini, Linux server, NAS). Many customers — especially regulated SMBs — do not want to manage Docker, TLS certificates, backups, and key rotation. Sgridworks offers a managed-service tier that handles the operational burden for a monthly fee.

---

## The Operational Burden Problem

Local-first deployment means:

- Customer owns the hardware
- Customer owns the network (port forwarding, firewall)
- Customer owns TLS certificates (renewal, rotation)
- Customer owns backups (local redundancy, offsite)
- Customer owns key rotation (API keys, session secrets)
- Customer owns monitoring (disk full, service down, cert expiry)

For a 10-person real estate brokerage, none of this is core competency. They will either under-configure (no TLS, no backups) or refuse to install at all because the operational complexity is too high.

The managed tier solves this. Sgridworks becomes the operational partner without taking custody of the customer's data.

---

## Tier Comparison

| | Self-Host (Free) | Managed (Sgridworks) |
|---|---|---|
| Software updates | Customer pulls via `agentworks update` | Sgridworks pushes updates on agreed schedule |
| Docker / infra | Customer manages | Sgridworks manages via remote access |
| TLS certificates | Customer configures | Sgridworks provisions + auto-renews via Let's Encrypt |
| Backups | Customer-run `agentworks backup` | Sgridworks configures daily encrypted backup to customer-owned S3/b2 |
| Key rotation | Customer-run `agentworks rotate-keys` | Sgridworks rotates on schedule |
| Monitoring | Customer reviews logs | Sgridworks monitors uptime + alerts customer |
| Support | Community forum | Email + next-business-day response |
| Compliance evidence report | Customer generates | Sgridworks generates + delivers monthly |
| Price | Free | $X/month (see pricing) |

---

## The Three Engagement Shapes

### Shape 1 — Install Only
Sgridworks installs AgentWorks OS on customer hardware, configures MCP pairing with their agents, seeds initial memory from a guided onboarding conversation. Customer owns everything after handoff.

- **Sgridworks deliverable**: install completed, first workflow run verified
- **Customer commitment**: hardware, network, ongoing operations
- **Price**: one-time install fee ($TBD)
- **Typical duration**: 1-day on-site or 2-day remote

### Shape 2 — Install + Ongoing
Sgridworks installs and manages the operational layer indefinitely. Customer owns their vault data, rule packs, and agent configs. Sgridworks handles updates, TLS, backups, monitoring.

- **Sgridworks deliverable**: all operational burden removed from customer
- **Customer commitment**: monthly fee, customer-owned data stays local
- **Price**: $TBD/month per tenant
- **Typical duration**: rolling monthly retainer

### Shape 3 — Managed (Full)
Sgridworks manages everything including periodic rule-pack tuning, compliance evidence report generation, and quarterly review calls. Customer's role is to run workflows and review the monthly compliance report.

- **Sgridworks deliverable**: full operational + compliance support
- **Customer commitment**: highest monthly fee, provides business context for rule packs
- **Price**: $TBD/month + setup fee
- **Typical duration**: rolling quarterly contract

---

## The Handoff Protocol (Shape 1 → Shape 2)

When a customer moves from self-host to managed:

1. **Kickoff call** (1 hour): confirm scope, share read access to their `~/.agentworks/config` directory via secure tunnel
2. **Secrets transfer**: customer runs `agentworks export-secrets` and sends the encrypted bundle to Sgridworks via a one-time link
3. **Sgridworks onboards** to the customer's deployment: configures monitoring agent, schedules backup, verifies TLS
4. **Verification**: Sgridworks runs the verification suite (see PLAN.md §Verification) against the customer's deployment
5. **Handoff call** (1 hour): walk through the monitoring dashboard, backup status, update schedule

Sgridworks never has persistent access to the customer's vault data. The operational access is scoped to:
- `~/.agentworks/config/` — service configs, non-sensitive
- `~/.agentworks/logs/` — read-only log access
- Backup blob storage — customer-owned, Sgridworks has write-only access to the backup bucket

---

## Key Rotation Procedure

For managed customers, Sgridworks rotates keys on this schedule:

| Key | Rotation frequency | Method |
|-----|------------------|--------|
| `AGENTWORKS_SESSION_SECRET` | Monthly | `agentworks rotate-keys --session` |
| `POSTGRES_PASSWORD` | Quarterly | `agentworks rotate-keys --db` |
| Admin password | Semi-annually | Customer-initiated via admin UI |
| MCP pairing tokens | Per-agent, on demand | `agentworks mcp rotate-token` |

All rotations are logged to the activity log with `actor: sgridworks-ops` and exported in the monthly compliance evidence report.

---

## Backup Verification

Managed customers receive daily encrypted backups written to their own cloud storage (customer provides the bucket; Sgridworks has write-only credentials).

Backup schedule:
- Daily at 02:00 customer local time
- Retention: 30 days
- Verification: Sgridworks runs a monthly test restore to a sandbox environment and confirms the vault integrity check passes

Sgridworks tests the backup restoration procedure with every major version upgrade.

---

## Pricing Framework (Placeholder — operator to Set)

The managed-service tier should be priced as a multiple of the customer's expected time savings. If a regulated SMB values 2 hours/month of compliance work at $200/hr, the monthly value is $400. Price the managed tier at $150-250/month to leave headroom.

Three tiers:
- **Starter**: $149/month — updates + monitoring + TLS (max 5 agents)
- **Professional**: $349/month — starter + backups + key rotation (max 25 agents)
- **Enterprise**: $799/month — professional + compliance evidence report + quarterly review (unlimited agents)

Volume discount: 3+ tenants → 15% off.

---

## Conflict of Interest Rules

Sgridworks manages the operational layer but does NOT own the customer's vault data. This is a hard boundary:

- Sgridworks staff cannot read vault data without explicit customer approval per-incident
- Sgridworks staff cannot access agent prompts or outputs without explicit customer approval per-incident
- Sgridworks may never use a customer's vault data to train models or improve other customers' deployments
- All Sgridworks operational access is logged with timestamps and reviewer IDs in the activity log

The compliance evidence report makes this boundary visible to the customer — every Sgridworks access event is logged and included in the report.

---

## Escalation

Managed customers with issues follow this path:

1. **Customer submits** via `agentworks support-bundle` CLI → uploads to Sgridworks support portal
2. **Sgridworks acknowledges** within 4 business hours
3. **Sgridworks diagnoses** and either resolves or escalates to engineering
4. **Critical incidents** (service down): Sgridworks responds within 1 hour, targets resolution within 4 hours

Emergency access procedure: if Sgridworks needs to access customer deployment urgently, the customer approves a time-boxed session (max 2 hours) via the admin UI approval queue. All actions are logged and included in the next compliance evidence report.

---

## Compliance Evidence Report Integration

For managed customers, Sgridworks generates the monthly Compliance Evidence Report (see PLAN.md §Compliance Evidence Report) and delivers it to the customer via encrypted email.

The report includes:
- All agent actions in the period, with policy decisions
- Any policy violations (shadow mode events) and their dispositions
- Any Sgridworks operational access events
- Backup verification results
- Key rotation log
- Rule pack versions active during the period

The customer signs off via the admin UI. Sgridworks countersigns and archives.

---

*This document lives at `docs/sgridworks-managed-service-tier.md`. For the most current version, see the Sgridworks internal wiki.*
