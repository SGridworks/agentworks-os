# Security Policy

## Supported Versions

Security fixes target the latest public release line. During `0.x`, only the newest minor release receives fixes unless a maintainer explicitly backports a patch.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting for this repository when available.

If private reporting is not available, open a minimal GitHub issue that describes the affected component and impact without including exploit code, secrets, credentials, customer data, or private logs. A maintainer will move the discussion to a private channel.

## Sensitive Data

Never attach:

- API keys, access tokens, passwords, private keys, or session cookies.
- Vault content, customer notes, customer names, or support bundles.
- Local database files.
- Machine-specific paths or hostnames that identify a private environment.

Use redacted examples and synthetic fixtures.
