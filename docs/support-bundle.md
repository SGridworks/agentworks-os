# Support Bundle

When maintainers ask for diagnostic information, collect a support bundle manually. The `agentworks support-bundle` command is not yet implemented.

## What to collect

Run each of these commands on the machine running AgentWorks OS and save the output:

### Service status and versions

```
docker compose -f ~/.agentworks/docker-compose.yml ps > service-status.txt
docker compose -f ~/.agentworks/docker-compose.yml version > compose-version.txt
docker --version > docker-version.txt
```

### Container logs (past 24 hours)

```
docker compose -f ~/.agentworks/docker-compose.yml logs --tail=1000 > container-logs.txt
```

To include logs from a specific service, add the service name:

```
docker compose -f ~/.agentworks/docker-compose.yml logs --tail=500 agentos-d > agentos-d-logs.txt
docker compose -f ~/.agentworks/docker-compose.yml logs --tail=500 scanner-worker > scanner-logs.txt
```

### Scanner findings

```
curl -s http://localhost:7710/api/scanner/findings > scanner-findings.json
```

### Policy packs list

```
curl -s http://localhost:7710/api/policy/packs > policy-packs.json
```

### System info

```
df -h > disk-space.txt
docker info > docker-info.txt
```

## Redaction

Before sending, manually redact the following from text files:

**Always redact:**
- LLM API keys and credentials
- Customer vault content
- Contact PII (names, phone numbers, email addresses)
- Admin passwords and session tokens

**Anonymize:**
- Actor labels and IDs → replace with `actor_N`
- Tenant/company names → replace with `tenant_N`

**Never include:**
- Raw rule pack YAML files — send the metadata summary instead
- The `agentworks.yml` credentials file

## Sharing with maintainers

1. Put all the output files in one directory
2. Create a tar.gz archive:
   ```
   tar -czf support-bundle.tar.gz *.txt *.json
   ```
3. Share it through the private upload channel requested by the maintainer

Do not email the bundle directly. Use the secure upload mechanism.

## What to include in your support request

The bundle covers the technical picture. Include in your support ticket:
- What you were trying to do when the issue occurred
- When the issue started (time, date, timezone)
- Any error messages you saw (from error-messages.md if listed, or verbatim)
- Steps to reproduce if known
