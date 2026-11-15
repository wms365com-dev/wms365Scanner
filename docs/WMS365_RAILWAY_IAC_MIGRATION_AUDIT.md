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

## Completed Migration Evidence - 2026-11-14

- Source: commits `a2972207df820a3ec7e28e6db1ee9018d17566e1` and `75fd7152e53ea47ef11d9cf79ba0d5bf0db039ec` on durable branch `codex/production-release`.
- Tests: focused Railway/runtime contracts passed 6/6; access-control audit passed 12/12 across 292 routes; deployment gate passed 759/759; production dependency audit reported zero vulnerabilities.
- Sandbox: deployment `6431763c-d324-4f7a-ade8-24cc9123c801` completed successfully from exact commit `75fd7152e53ea47ef11d9cf79ba0d5bf0db039ec`. Fresh-database verification passed all seven schema controls. The authenticated designated-company workflow returned 321 allowed tasks, excluded 19 denied-warehouse and 11 denied-company tasks, returned HTTP 403 for cross-company access, and cleaned up its isolated fixtures.
- Sandbox soak: 11/11 health samples passed from `2026-11-15T01:30:13Z` through `2026-11-15T01:40:15Z`; maximum client-observed response time was 338 ms. Runtime logs contained no application warning or error, and the one-hour Railway window contained zero HTTP 5xx responses.
- Production preflight: deployment `04899d1f-4a84-46ba-a018-4cfaaf84fd13` was healthy and recorded as the immediate rollback artifact. The IaC plan contained three non-destructive service-setting updates, zero additions, zero deletions, and no managed variable changes.
- Production: deployment `6ab7427d-1fc0-4133-aff8-d41370db9ddc` completed successfully from exact commit `75fd7152e53ea47ef11d9cf79ba0d5bf0db039ec`. Five consecutive read-only health checks returned HTTP 200 with database, schema, desktop, and mobile readiness true. The one-hour Railway window contained zero HTTP 5xx responses across 625 requests.
- Drift: post-deployment plans for `production` and `customer-sandbox` both report configuration up to date. Railway has no staged changes in either environment. Production and sandbox variables remain intentionally unmanaged so no secret value is stored in source.
- Promotion guard: an evidence-only push exposed that a shared branch follower would auto-deploy both environments. Production is now pinned to reviewed commit `75fd7152e53ea47ef11d9cf79ba0d5bf0db039ec`; only sandbox follows `codex/production-release`. Future production movement requires an explicit reviewed commit-pin promotion after sandbox verification.
- Data safety: no live transaction, customer record, inventory quantity, email, billing record, integration state, or production database service was created, copied, restarted, or modified by this migration.

## Remaining Audit Risks

- Production schema readiness took approximately 151 seconds, versus approximately 2 seconds in the isolated sandbox. It completed without an application error or HTTP 5xx response, but the initialization path and database probe latency should be profiled before the next schema-affecting release.
- Production health probes currently spend approximately 770-780 ms in the database probe. This is healthy but materially slower than the sandbox and should be tracked as a performance item.
- GitHub reports dependency alerts on the repository default branch. The deployed release branch's `npm audit --omit=dev --audit-level=high` result is clean; default-branch alerts require a separate source and reachability review before being merged into this release line.
- Future releases must continue to use a clean committed source, dual-environment zero-destruction plans, isolated sandbox verification, a 10-minute soak, a named production rollback deployment, and read-only production verification.
- Documentation-only pushes still deploy sandbox because sandbox intentionally follows the release branch. Add Railway watch patterns or a dedicated candidate branch if unnecessary sandbox rebuilds become operationally noisy; production remains protected by the commit pin.
