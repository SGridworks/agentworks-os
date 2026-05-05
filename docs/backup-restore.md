# Backup and Restore

## When to back up

- Before upgrading AgentWorks OS
- Before changing rule pack configuration
- Before reseeding or bulk-writing vault content
- Weekly as part of normal operations

## What gets backed up

The backup archive contains:
- The full vault (memory files, documents, manifest)
- The database (actions log, policy decisions, scanner findings, user accounts)
- Agent configuration references (not the configs themselves — those live on-agent)

It does not include:
- Container images
- Docker Compose configuration
- The `agentworks.yml` credentials file

## Creating a backup

```
agentworks backup --output /path/to/backup.tar.gz
```

Or from Docker directly:

```
docker exec agentos-d agentworks backup --output /backups/backup-$(date +%Y%m%d).tar.gz
```

Backups are encrypted with a passphrase you provide. The passphrase is not stored anywhere — you must remember it.

## Restoring from a backup

```
agentworks restore --input /path/to/backup.tar.gz
```

You'll be prompted for the passphrase.

Restore is destructive: it replaces the current vault and database with the contents of the archive. It does not touch container images or Docker configuration.

## Testing a restore

Before you need a restore to work, test it:

1. Create a backup: `agentworks backup --output test-backup.tar.gz`
2. Make a small change (add a note to the vault, approve a pending action)
3. Restore: `agentworks restore --input test-backup.tar.gz`
4. Confirm the small change is gone

If the change persists after restore, the vault seeding from onboarding may have run again. Check that the backup was created after the change was made.

## Retention

| Environment | Recommended retention |
|---|---|
| Production | 30 days, one per week |
| Staging / test | 7 days |
| Before upgrades | One backup per upgrade |

Keep at least one pre-upgrade backup after every update. Store it somewhere other than the same machine running AgentWorks OS — if the machine fails, a local backup goes with it.

## Off-machine backup

The backup archive is just a file. Copy it to another machine or storage device:

```
scp backup.tar.gz user@backup-server:/path/to/backups/
```

Or use any file copy tool. The archive is encrypted, so copying it over an untrusted channel is safe as long as the passphrase is not transmitted over the same channel.

## Backup to Google Drive

If you use the sgridworks managed tier:

```
agentworks backup --output /path/to/backup.tar.gz
```

Then upload manually to the Google Drive folder your sgridworks account manager gave you. The managed tier does not currently automate cloud backup.

## What is not included and why

- **Container images**: backed up separately via Docker's own mechanisms if needed. Re-pull from GHCR.
- **`agentworks.yml`**: this file contains credentials for connecting to the sgridworks update service. Regenerate it with `agentworks init` if lost.
- **Agent configs (CLAUDE.md, .cursorrules)**: these live on the agents themselves, not on the AgentWorks OS server. Back them up as part of your normal agent configuration backup.
