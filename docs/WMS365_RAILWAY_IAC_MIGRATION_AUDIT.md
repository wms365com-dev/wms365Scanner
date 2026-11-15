# WMS365 Railway IaC Migration Audit

## Scope

This audit protects the production and customer-sandbox release flow while replacing deprecated `railway.json` configuration with `.railway/railway.ts`.

## Environment Inventory

- Production: `wms365Scanner`, `Ranchers-Order-Flow`, `WMS365-Delivery-Tracking`, `Postgres`, `postgres-volume`, and `Postgres-PITR`.
- Customer sandbox: `wms365-sandbox`, `Postgres-XihR`, and `postgres-volume-xlJ6`.
- Production custom domains remain attached only to `wms365Scanner`.
- The sandbox Railway service domain remains platform-managed and is not declared as a custom domain.
- Variables are unmanaged by IaC: 32 production variables and 14 sandbox variables remain in Railway. No values or secrets are stored in source.

## Required Deployment Controls

Both WMS365 application services declare:

- build command: `npm run check:deploy`
- start command: `node server.js`
- healthcheck: `/api/health`
- restart policy: `ON_FAILURE`, maximum 10 retries

The IaC program fails closed for any environment other than `production` or `customer-sandbox`.

## Audit Gates

1. `npm run check:railway-config` must evaluate both environments.
2. No plan may delete or replace a service, database, volume, bucket, domain, or private-network endpoint.
3. `npm run audit:access-control` and `npm run check:deploy` must pass.
4. `npm audit --omit=dev --audit-level=high` must report no production vulnerability.
5. Apply configuration to `customer-sandbox` first, then run fresh-database boot, authenticated designated-company isolation checks, health verification, log review, and a 10-minute soak.
6. Production configuration may be applied only after sandbox evidence passes and a named rollback deployment is recorded.
7. Production verification is read-only and includes health, route readiness, deployment state, runtime logs, and HTTP 5xx review.

## Rollback

Railway Config-as-Code ownership is already disabled in both environments. The legacy `railway.json` file can therefore be removed without changing platform resources. Source rollback restores the prior repository commit; platform rollback uses the named known-good application deployment recorded for each release. Database services and customer data are never restarted, copied, or modified by this migration.
