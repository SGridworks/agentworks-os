# Kill Criterion Checkpoint — 2026-06-15

**Read this document on 2026-06-15 to evaluate the AgentWorks OS bet.**

---

## The bet

Build a local-first AI compliance substrate for regulated SMBs. First pilot target: regulated SMB. Target install: on or before 2026-05-25.

## Kill criterion

We declare the bet failed if, by 2026-06-15:

1. the pilot has not used AgentWorks OS unprompted for 7 consecutive days, **AND**
2. no second customer has installed and run a real workflow

Both conditions must be true to kill the bet. If the pilot is using it weekly OR a second customer is running real workflows, the bet continues.

If the kill criterion fires, run a /office-hours retrospective before iterating.

---

## Diagnostic questions

If the criterion fires, the question is: which assumption failed?

### Assumption 1: Compliance positioning

No one cares about regulated-SMB AI compliance yet.

**Signal:** the pilot uses the system but never triggers a policy decision. The compliance engine is invisible to the workflow.

**What to check:** How many actions has the policy engine evaluated? How many decisions are in the log? Is the TCPA pack actually in enforce mode?

### Assumption 2: Memory + orchestration value

The underlying substrate doesn't deliver enough.

**Signal:** the pilot uses it for memory but doesn't mention orchestration or cross-agent workflows.

**What to check:** How many memory read/write calls per week? How many agent-to-agent handoffs? Does the n8n workflow get used?

### Assumption 3: Local-first deployment

SMBs won't manage infrastructure even with the managed tier option.

**Signal:** the pilot doesn't reinstall after the first week. The Docker dependency is the blocker.

**What to check:** How many times did the pilot restart the Docker service? Were there support requests about Docker errors?

### Assumption 4: Vertical fit

The initial workflow wedge may not repeat across regulated SMBs.

**Signal:** the pilot never ran a real lead-gen workflow through the system. They used it for something else.

**What to check:** What workflow did the pilot actually run? Does it match the compliance wedge?

### Assumption 5: UX

Rule pack authoring is too hard. Onboarding is too complex.

**Signal:** the pilot set up the system but never loaded a custom rule pack. They stopped at the default packs.

**What to check:** Did the pilot complete the onboarding wizard? How long did it take? Did they load a second rule pack?

---

## What to gather before the retrospective

The following data points answer the diagnostic questions above:

1. Pilot usage stats: policy decisions per week, memory calls, agent handoffs
2. The second customer's install date, workflow type, and policy decision count
3. Support tickets opened: count, category, time to resolution
4. The compliance evidence report: how many actions were blocked, routed, allowed in the last 30 days?
5. Any sanitized feedback about what the pilot was trying to do when they used the system

All of this is in the admin UI and the database. Export the policy decisions table for the period.

---

## If the criterion does NOT fire

If both conditions are false (pilot is active OR second customer is running workflows):

- Continue to the next milestone
- Schedule the next checkpoint for 30 days later
- Document what's working in the project wiki

---

## Who decides

the operator decides after reviewing this document with the team.

The decision options:

- **Continue**: bet holds, proceed to next milestone
- **Pivot**: one of the five assumptions failed; redefine the product or the positioning
- **Kill**: the market timing is wrong; shelve the product

Document the decision in the Decision-Log.md in the vault.
