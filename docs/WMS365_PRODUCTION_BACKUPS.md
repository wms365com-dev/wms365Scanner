# WMS365 Production Backup Runbook

Last reviewed: 2026-09-26

## Recovery design

WMS365 uses defense in depth. No single backup layer is sufficient.

1. Keep Railway daily and weekly volume snapshots on PostgreSQL. As of 2026-09-26, daily retains six days and weekly retains 27 days; monthly is off because its 89-day retention exceeds the approved 30-day policy.
2. Enable Railway PostgreSQL point-in-time recovery (PITR).
3. Run `ops/backup` once per day as a separate Railway cron service.
4. Send its client-side encrypted logical backup to a private, versioned, Object-Locked S3 bucket in a separately administered AWS account outside Railway. Each backup and attestation uses 30-day COMPLIANCE retention.
5. Run a restore verification against a dedicated, isolated restore database at least monthly.

The logical backup is the disaster-recovery copy. It contains:

- a PostgreSQL custom-format dump (`pg_dump`), including WMS365 document records stored in PostgreSQL `bytea` and text columns;
- the complete deployed application source present in the Railway build context, including `server.js`, web assets, scripts, migrations, and release configuration; local secrets and generated artifacts are excluded by `ops/backup/Dockerfile.dockerignore`;
- every explicitly configured persistent volume path;
- an internal manifest with a SHA-256 checksum and size for every archived file;
- release metadata supplied by Railway.

The entire tar archive is encrypted before upload with AES-256-GCM. The job verifies remote size, S3 SHA-256 checksum, and compliance retention on both the backup and its attestation. The unencrypted attestation contains only object keys, timestamp, byte count, ciphertext checksum, and lock expiry—never customer data or secrets. The backup job has no delete operation.

## Railway service configuration

Create a new service from the same repository. It must use the repository root as its build context and `ops/backup/Dockerfile` as its Dockerfile. Configure the cron schedule as `15 5 * * *` (05:15 UTC daily). The process exits after every run, as Railway cron services require.

The image uses PostgreSQL 18 client tools to match the production PostgreSQL major version verified on 2026-09-26. Recheck this pairing before a database major-version upgrade.

Do not deploy this service until the destination bucket, encryption key, alert endpoint, and restore environment are approved. Do not reuse the application or Railway PITR bucket for disaster-recovery backups. The build and full restore still require validation in an isolated environment.

Required variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Private-network PostgreSQL connection reference. |
| `BACKUP_ENCRYPTION_KEY_B64` | Base64 encoding of exactly 32 random bytes. Keep a recoverable copy in the approved password/secret manager outside Railway. Loss means the backups cannot be restored. |
| `BACKUP_S3_ENDPOINT` | HTTPS S3 endpoint for the separate account. |
| `BACKUP_S3_REGION` | Actual bucket region. |
| `BACKUP_S3_BUCKET` | Dedicated private bucket created with Object Lock and versioning enabled. |
| `BACKUP_EXPECTED_BUCKET_OWNER` | 12-digit AWS account ID; required for Amazon S3 to prevent wrong-bucket writes. |
| `BACKUP_S3_ACCESS_KEY_ID` | Writer credentials scoped to this bucket/prefix, with no delete, retention-change, or bypass permission. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Secret for the scoped bucket credential. |

Recommended variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_S3_PREFIX` | `wms365-backups/production/` | Dedicated object namespace. It must be a child of `wms365-backups/`. |
| `BACKUP_RETENTION_DAYS` | `30` | Minimum compliance lock on each new object. Values below 30 are rejected. |
| `BACKUP_S3_FORCE_PATH_STYLE` | `false` | Set only when required by the S3 provider. |
| `BACKUP_ALERT_WEBHOOK_URL` | unset | Monitoring endpoint. Messages contain status metadata only. A missing webhook does not hide the cron process's non-zero failure exit. |
| `BACKUP_VOLUME_PATHS` | unset | Comma-separated absolute, read-only mount paths for any application files stored outside PostgreSQL. A configured missing path fails the whole backup. |

Generate the encryption key on an authorized workstation and place it directly in the secret manager; do not paste its output into tickets, chat, source control, or logs:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

The writer needs `s3:PutObject`, `s3:GetObject` for `HeadObject` metadata, `s3:GetObjectRetention`, `s3:GetBucketVersioning`, and `s3:GetBucketObjectLockConfiguration`. Scope it to the dedicated bucket/prefix. Use a separate recovery role for restore drills. Do not grant `s3:DeleteObject`, `s3:PutObjectRetention`, `s3:BypassGovernanceRetention`, bucket-policy changes, or bucket deletion to the writer. Store the encryption key in an approved secret manager outside Railway with an independently recoverable escrow copy. Losing this key makes the offsite backups useless.

## Retention and deletion safety

The job creates one immutable daily archive and attestation on every successful run. Before any database dump it checks bucket versioning and Object Lock. Every uploaded object is held in COMPLIANCE mode for at least 30 days. The job cannot delete or prune backup objects.

Configure expiration with an independently reviewed bucket lifecycle policy only after the first isolated restore drill succeeds. Use a window longer than the compliance lock to allow for late runs and investigation; storage/cost implications require owner approval. Until then, objects accumulate rather than risking premature deletion. Lifecycle changes must not be available to the backup writer.

## Restore verification

Use a dedicated restore database on a separate server with no application traffic. Never point verification at production. The verifier requires both an explicit opt-in and a database name containing `restore`, `verify`, `test`, or `scratch`, and it rejects the source database host and port. Review the target identity manually before running; the name guard is not a substitute for separate credentials and network isolation.

Set the normal backup variables plus:

```text
ALLOW_RESTORE_VERIFICATION=true
BACKUP_OBJECT_KEY=wms365-backups/production/daily/YYYY/MM/<verified-object>.tar.enc
RESTORE_VERIFY_DATABASE_URL=<isolated restore database URL>
```

Then run:

```bash
npm --prefix ops/backup run restore:verify
```

The verifier downloads the object, compares its SHA-256 with both object metadata and S3 checksum, authenticates and decrypts it, restores with `pg_restore --clean --if-exists --exit-on-error`, and verifies that public tables are readable. It intentionally overwrites the isolated restore database. Record the result, duration, source recovery-point age, and tester. Remove the scratch service through the normal approved infrastructure process after evidence is retained.

## Alerts and operating checks

- Treat any non-zero cron deployment as a failed backup; route Railway deployment alerts and `BACKUP_ALERT_WEBHOOK_URL` failures to the system owner.
- Resolve the Railway past-due subscription warning immediately; platform suspension would put both production and native recovery at risk.
- Alert if no successful daily attestation is newer than 30 hours.
- Review bucket object count and storage growth monthly.
- Perform and record the isolated restore drill monthly.
- After schema, document-storage, integration-storage, or volume changes, update `BACKUP_VOLUME_PATHS` and this runbook before release.
- Keep Railway snapshots and PITR enabled even after logical backups are healthy.
- Review backup coverage for external integrations, credentials, DNS, and any application volumes not mounted into the cron service; the PostgreSQL dump and code archive do not contain these resources.

## Official Railway capability evidence

Reviewed 2026-09-26:

- [Back Up and Restore Postgres](https://docs.railway.com/guides/postgres-backups-restores): Railway recommends volume backups, PITR, and portable logical dumps; logical dumps are the layer that survives project deletion.
- [Point-in-Time Recovery](https://docs.railway.com/volumes/point-in-time-recovery): PostgreSQL PITR uses rolling base backups and WAL archiving and restores into a sibling service.
- [Cron Jobs](https://docs.railway.com/cron-jobs): schedules use UTC; jobs must terminate; overlapping runs are skipped.
- [Storage Buckets](https://docs.railway.com/storage-buckets): buckets are private and S3-compatible; server-side encryption, object versioning, object locks, and lifecycle configuration are not currently supported.
- [Volumes](https://docs.railway.com/volumes/reference): persistent volumes support manual and automated snapshots.
- [Amazon S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html): compliance retention prevents object removal or replacement during the retention period and requires versioning.
- [Amazon S3 PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html): upload supports object-lock retention and SHA-256 checksums.

## Provisioning checklist

- [ ] Confirm the production PostgreSQL service and variable reference without exposing the URL.
- [x] Enable native daily and weekly volume backups; monthly deliberately off.
- [x] Enable PostgreSQL PITR and confirm the first base backup and WAL archive are healthy.
- [ ] Provision a separate-account private bucket with Object Lock and versioning.
- [ ] Create a least-privilege bucket writer with no delete or retention-change permissions.
- [ ] Generate and escrow the AES-256 key outside Railway.
- [ ] Provision the daily cron service and configure the variables above.
- [ ] Configure owner alerting and the 30-hour freshness monitor.
- [ ] Identify and mount every non-database persistent path read-only, or document that none exist.
- [ ] Provision an isolated restore-verification database.
- [ ] Run one backup, verify its attestation, and complete a restore drill before declaring protection operational.
- [ ] Record recovery time and recovery point measurements.
