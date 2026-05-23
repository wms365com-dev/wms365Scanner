# WMS365 Production Security Hardening

## Startup Guards

Production startup now refuses to run unless these are configured:

- `APP_ADMIN_EMAIL`
- `APP_ADMIN_PASSWORD`
- `DATABASE_URL` or `DATABASE_PRIVATE_URL`
- `INTEGRATION_SECRET_KEY` or `APP_SECRET`

The old default admin email/password fallback was removed. If admin credentials are not configured, no default admin is created.

## Upload Safety

Customer and warehouse document uploads are limited to:

- PDF
- JPEG
- PNG
- WebP

The server rejects SVG, executable signatures, unknown MIME types, and mismatched file content. Download routes now serve uploaded documents as attachments with `X-Content-Type-Options: nosniff`.

## Integration Secrets

Store integration secrets are encrypted at rest with AES-256-GCM:

- Shopify access tokens
- Shopify client secrets
- SFTP passwords
- Custom API access tokens stored in `access_token`

Legacy plaintext values are still readable and will be re-saved encrypted when the integration is updated or refreshed.

## Destructive Import Protection

`POST /api/import` now requires:

- Super admin access
- `ALLOW_DESTRUCTIVE_IMPORTS=true` in production
- typed confirmation token: `IMPORT WMS365`
- automatic pre-import backup saved to `import_backups`
- activity log entry with the backup id

## Runtime Security

Added:

- production environment validation
- `/api/health` returns `503` unless the database is healthy
- secure cookies in production
- same-origin protection for state-changing requests in production
- basic login brute-force throttling
- safer error logging for secret-like values

## Validation

Run:

```bash
npm run test:security-hardening
npm run test:rbac
npm run test:inventory-locking
npm run test:mobile-execution
```
