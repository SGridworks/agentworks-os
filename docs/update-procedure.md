# Update Procedure

AgentWorks OS uses signed container images on GHCR. The update CLI pulls new images, runs migrations, and restarts services.

## How updates work

Updates are signed tar.gz bundles published to GitHub Releases. The `agentworks update` CLI verifies the signature before applying anything.

Migrations run automatically on first boot of the new version. Migrations are idempotent: running them multiple times against the same state produces the same result.

## Semver expectations

| Version change | What happens |
|---|---|
| Patch (1.0.0 -> 1.0.1) | Bug fixes, no schema changes. No migration. |
| Minor (1.0.0 -> 1.1.0) | New features, schema additions. Migrations run forward only. |
| Major (1.0.0 -> 2.0.0) | Breaking changes. Migration may be destructive. Check the release notes. |

You control when updates are applied. There is no forced auto-update.

## Checking your current version

```
agentworks version
```

## Checking for updates

```
agentworks update --check
```

This reports the latest available version without applying it.

## Applying an update

```
agentworks update
```

The update process:

1. Verifies Docker is running
2. Pulls the new image from GHCR
3. Verifies the image signature
4. Stops running services
5. Runs database migrations
6. Starts services with the new image
7. Verifies all services are healthy

Total time: 2-5 minutes.

## AWCP v0.1 to v1.0

The AWCP spec ships at v0.1 draft in v1. Breaking changes are allowed in v0.x. The v0.1 draft is identified as draft in the document header.

When the spec reaches v1.0, the following breaking changes are possible:

- New required fields in the canonical action schema
- New policy decision data model fields
- Rule pack schema additions that require pack version bumps

If you have custom rule packs written against v0.1:

1. Read the v1.0 release notes when published
2. Run `agentworks pack validate /path/to/your-pack.yaml` against the new version before upgrading
3. Update your pack's `version` field and any changed field paths
4. Load the updated pack in shadow mode first

The v0.1 to v1.0 transition is the only planned breaking change in the v1 lifecycle. After v1.0, semver guarantees apply.

## Reverting a failed update

If an update fails mid-way:

```
docker compose down
docker compose up -d
```

This restarts the previous version (the image hasn't been replaced until the full update succeeds).

If the database migration failed:

```
docker compose logs agentos-d | grep migration
```

Contact sgridworks support with the migration error. Do not attempt to manually modify the database to work around a failed migration.

## Pre-update checklist

Before updating:

1. Back up: `agentworks backup --output pre-update-$(date +%Y%m%d).tar.gz`
2. Check release notes: `agentworks update --check` and read the output
3. Confirm disk space: `df -h` on the server — need at least 5 GB free
4. Notify approval queue reviewers if a migration affects the policy engine

## Update and rule packs

Rule packs are data, not code. They persist across updates. A backup before an update includes your active rule packs.

If a new version ships a new default rule pack, it is added alongside your existing packs, not replacing them.
