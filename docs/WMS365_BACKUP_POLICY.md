# WMS365 Backup Policy

## Temporary Change Protection

Before a high-risk production repair or database migration:

1. Create a local code snapshot and repository bundle.
2. Export all production database tables.
3. Record SHA-256 checksums and verify the archives can be read.
4. Keep the temporary backup only until the corrected build is committed, pushed, deployed, and smoke-tested.
5. Securely delete the temporary local backup after validation.

The `backups/` directory is excluded from Git and Railway deployments.

## Ongoing Production Protection

- Use an automated PostgreSQL-native backup every night.
- Encrypt backups before they leave the database environment.
- Store backups off the application server and off employee computers.
- Keep 7 daily, 4 weekly, and 12 monthly recovery points.
- Test a restore into an isolated environment at least once per month.
- Alert the system owner when a backup or restore verification fails.
- Never include application secrets, passwords, API keys, or active session tokens in code archives.

Local temporary exports are an additional pre-change safeguard. They do not replace managed, encrypted, off-site backups.
