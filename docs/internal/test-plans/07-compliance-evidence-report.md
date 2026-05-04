# Test Plan: Pillar 7 — Compliance Evidence Report

**Pillar**: Compliance Evidence Report PDF
**Owner**: BackendEngineer
**QA**: QAEngineer
**Status**: Not started

## Verification Gate
Monthly rollup PDF generates; signed/hashed; "evidence of system state, not legal compliance" disclaimer present.

## Prerequisites
- `agentos-d` running with populated audit log
- At least one policy decision record in the database

## Test Fixtures

### 1. PDF generates with valid structure
**Approach**: Call the evidence report API endpoint; verify PDF is returned.

**Assertions**:
- [ ] HTTP 200 with `Content-Type: application/pdf`
- [ ] PDF is non-empty (> 1KB)
- [ ] PDF contains the tenant name and date range

### 2. PDF is signed and hash-verifiable
**Approach**: Extract the hash from the PDF metadata; verify it matches the audit log hash for the period.

**Assertions**:
- [ ] PDF includes a SHA-256 hash of the audit log for the period
- [ ] Hash value is present in PDF metadata or cover page
- [ ] Hash matches the value computed from the raw audit log

### 3. Disclaimer is present
**Approach**: Extract text from the PDF; search for the required disclaimer.

**Assertions**:
- [ ] PDF contains: "evidence of system state, not legal compliance"
- [ ] Disclaimer is on the first page or cover

### 4. Monthly rollup covers the correct period
**Approach**: Generate a report for a known 30-day window; verify records are included.

**Assertions**:
- [ ] All policy decisions within the window are included
- [ ] No records from outside the window are included
- [ ] Record count matches `SELECT COUNT(*) FROM policy_decisions WHERE proposedAt BETWEEN ? AND ?`

### 5. Zero-activity period produces a valid PDF
**Approach**: Request a report for a window with no activity.

**Assertions**:
- [ ] PDF is still generated (not an error)
- [ ] PDF states "No compliance activity during this period"
- [ ] Hash is still computable (of empty log for period)

## Dependencies
- `agentos-d` must expose `/api/reports/evidence` endpoint
- PDF generation library (e.g., `@agentworks/pdf`, puppeteer, or pdfkit)

## Known Blocker
Evidence report endpoint does not yet exist in `agentos-d`. This plan is `blocked` until AWO-XXX (evidence report generator) is implemented.

## Pass Criteria
All 5 scenarios produce correct output. Disclaimer is present and legally accurate.
