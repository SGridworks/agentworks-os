# Pilot Learnings Template

Use this document to capture pilot-install learning without recording customer
names, company names, personal details, private quotes, or buyer-specific
commercial terms.

## Pilot Context

- **Segment:** regulated SMB
- **Deployment shape:** local-first, customer-controlled infrastructure
- **Primary workflow:** compliance-aware AI automation
- **Status:** replace with current public-safe status

## What We Had Going In

Record only product state and objective pilot criteria:

- daemon and installer readiness
- backup and restore readiness
- policy engine readiness
- rule-pack coverage
- scanner and evidence-report readiness
- MCP pairing readiness

## What We Learned

### 1. The install is not the product. The outcome is.

Lead with the outcome the operator gets: auditable AI actions, policy checks,
human review, and recoverable local state. Treat the installation path as a
delivery detail.

### 2. Shadow mode is part of trust building.

For first-time deployments, run policy checks in observe-only mode before
blocking live work. The customer should see what the system would have done
before they rely on enforcement.

### 3. Managed setup may be the right v1 delivery shape.

The self-serve installer should exist, but early pilots may need a managed setup
so product learning is not buried under local environment friction.

### 4. MCP pairing is the product moment.

The customer experiences AgentWorks OS when their existing agent tool can read
memory, write memory, and submit actions through policy checks. Structure the
runbook so this happens early.

### 5. Rule packs need to match the actual workflow.

Generic packs are useful for demonstration, but pilots need a pack that maps to
the workflow they intend to run. Record the missing workflow coverage without
including private customer details.

## Revised Onboarding Sequence

1. Confirm pilot scope and installation owner.
2. Install `agentos-d` and verify daemon health.
3. Pair the first MCP client.
4. Show memory read/write and a policy check from the client.
5. Run shadow-mode policy checks on a representative workflow.
6. Review evidence logs with the customer.
7. Move selected rules to enforce mode only after the shadow-mode review.

## Open Questions

- What customer data sources need to be connected?
- Which workflows need a custom rule pack?
- What is the minimum managed setup time?
- What would make the deployment repeatable for the next pilot?

## Redaction Rules

Do not include:

- customer or employee names
- customer company names
- private quotes or buyer language
- exact commercial terms
- personal device names or hostnames
- private paths, emails, keys, logs, or database excerpts
