# WMS365 Staging-First Release Policy

## Purpose

Protect live warehouse operations by proving every application release in an isolated environment before production promotion.

## Fixed Environments

- Sandbox environment: `customer-sandbox` (`ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6`)
- Sandbox application: `wms365-sandbox` (`98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b`)
- Sandbox database: `Postgres-XihR` (`809718dc-62b7-469c-a63e-88fa96b5230c`)
- Production environment: `production` (`e1f5b77e-b935-4f41-9cc5-fccb28edbc57`)
- Production application: `wms365Scanner` (`2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0`)

Sandbox must never reference production data or external live side effects.

## Required Release Sequence

1. Start from a clean release repository and record the commit SHA.
2. Review the complete committed diff, migrations, untracked files, and rollback path.
3. Run `npm run check:deploy`, access-control checks, focused regression tests, and fresh-database boot checks.
4. Run `npm run check:railway-config`. Review both environment plans and require zero destructive changes. Variables must remain unmanaged, and the plan must preserve every service, database, volume, domain, build gate, start command, healthcheck, and restart policy.
5. Deploy the exact commit to `customer-sandbox` only.
6. Verify application health, database schema readiness, route readiness, worker state, and logs.
7. Run authenticated workflows under the designated test company and realistic restricted roles. Test the changed workflow plus adjacent receiving, inventory, order, document, and portal behavior as applicable.
8. Confirm external effects are disabled or redirected to test fixtures. No real email, Shopify, carrier, billing, or customer notification is allowed.
9. Maintain a 10-minute healthy soak with no readiness failures, restarts, pool exhaustion, migration retries, or unexplained errors.
10. Record evidence in `docs/WMS365_SYSTEM_FIX_QUEUE.md`: commit, test counts, sandbox deployment ID, health results, workflow results, rollback artifact, reviewer, and timestamp.
11. Promote the same commit or immutable build to production by explicitly updating the production source commit pin. Production must never follow the sandbox release branch without a commit pin. Do not rebuild from another worktree.
12. Verify production health and database readiness read-only. Perform a live transaction only when it is an explicitly requested real business transaction.

## Verification Transport Failures

- A Railway CLI or SSH transport failure that occurs before the requested command starts is unavailable evidence, not an application test result or readiness failure.
- Retry the same read-only or sandbox-only command up to three times with the same candidate, environment, service, and agent session. Do not redeploy or restart merely to recover transport.
- Promotion remains blocked until every required command completes successfully. A later successful run may satisfy the gate only when Railway confirms the candidate stayed on the same deployment with no restart, warning, readiness loss, or source change between attempts.
- A command that starts and exits nonzero, times out inside the application, leaves uncertain fixture cleanup, or produces a readiness/schema/pool/worker warning is a real failed gate and remains a promotion blocker.
- Record transport attempts separately from application test outcomes so infrastructure observation failures cannot be mistaken for WMS365 regressions.

## Production Stop Conditions

Do not promote when any of the following is true:

- Sandbox identity, database isolation, credentials, or designated test company cannot be proven.
- Repository or release diff is dirty, mixed, or unreviewed.
- Any required test, access audit, migration check, or authenticated workflow fails.
- Either Railway environment plan includes an unreviewed deletion, replacement, variable mutation, or resource ownership change.
- Sandbox health is not continuously ready for 10 minutes.
- Startup or schema initialization approaches the platform readiness timeout.
- Database pool exhaustion, worker contention, duplicate side effects, or external integration writes occur.
- Rollback cannot be performed using a named known-good deployment.
- Production promotion is attempted through `railway up`, a local-directory upload, an unpinned branch follower, or any source other than the exact sandbox-proven commit pin.

## Emergency Recovery

When production is unavailable, prioritize service restoration. Restart only the affected application when evidence shows an application-local pool or process failure. Do not restart PostgreSQL unless explicitly authorized and database evidence requires it. Roll back to a named known-good artifact, verify health, and postpone feature deployment until the incident is understood and reproduced safely in sandbox.

## November 12, 2026 Incident

Two candidate deployments failed readiness while schema initialization remained incomplete. The prior live process then exhausted its database connection pool and returned `503`. Service was restored by restarting the known-good application deployment; PostgreSQL was not restarted and no production data was changed. This incident established the mandatory staging-first and health-soak requirements above.
