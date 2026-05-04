# Test Plan: Pillar 10 — Approval Queue

**Pillar**: Human Approval Queue
**Owner**: FrontendEngineer + BackendEngineer
**QA**: QAEngineer
**Status**: Not started

## Verification Gate
route_to_review decision lands in admin UI within 2s; reviewer ID logged.

## Test Fixtures

### 1. route_to_review appears in admin UI within 2s
**Approach**: Submit an action that returns `route_to_review`; poll the approvals API.

**Assertions**:
- [ ] `GET /api/approvals` returns the pending item within 2 seconds
- [ ] Item includes `requestId`, `actorId`, `actionKind`, `decisionReason`
- [ ] Item is marked `pending` (not yet reviewed)

### 2. Approve action works
**Approach**: Call `POST /api/approvals/{id}/approve` as a reviewer.

**Assertions**:
- [ ] HTTP 200
- [ ] Approval record is created in DB with `reviewerId`
- [ ] Subsequent `GET /api/approvals/{id}` shows `reviewDecision: approve`

### 3. Reject action works
**Approach**: Call `POST /api/approvals/{id}/reject`.

**Assertions**:
- [ ] HTTP 200
- [ ] Approval record shows `reviewDecision: reject`
- [ ] Original action is not re-evaluated

### 4. Reviewer ID is logged in audit trail
**Approach**: Approve an item; query the audit log.

**Assertions**:
- [ ] Audit log entry for the approval includes `reviewerId`
- [ ] `reviewerId` matches the actor who approved
- [ ] Timestamp is recorded

### 5. Approver can send back to author
**Approach**: Call `POST /api/approvals/{id}/send-back` with a note.

**Assertions**:
- [ ] HTTP 200
- [ ] Original agent receives the note
- [ ] Item is removed from approval queue

## Dependencies
- `/api/approvals` routes in `agentos-d`
- Admin UI approval queue view

## Pass Criteria
All 5 scenarios pass. route_to_review appears within 2s. All reviewer actions are logged.
