# WMS365 Operational Hardening Plan

Last updated: 2026-08-27

## Safety Boundary

- Development and automated checks run locally against fixtures or the designated test company.
- Do not write test transactions to a live customer company.
- Do not deploy a hardening package until its local suite passes and deployment is explicitly approved.
- Production verification is read-only unless a real business transaction is explicitly requested.

## Verified Baseline

- [x] Cross-platform Node test runner includes every root `*.spec.js` except the Playwright billing audit.
- [x] Playwright audit has a separate `npm run test:audit` command.
- [x] Node 20 GitHub Actions workflow runs `npm ci` and `npm test`.
- [x] Local baseline: 254 tests passed, 0 failed, 0 skipped on 2026-08-27.
- [x] No live database connection was used for the baseline.
- [x] Project-local Playwright Chromium is installed and launches headlessly.
- [x] Project-local Railway CLI is installed and callable without global PATH changes.
- [x] `pg-mem` is installed for isolated PostgreSQL-compatible unit and integration fixtures.
- [x] GitHub CodeQL scans JavaScript on pull requests, main-branch pushes, and weekly schedules.
- [x] GitHub Dependency Review blocks newly introduced high or critical dependency vulnerabilities.
- [x] Dependabot checks npm and GitHub Actions dependencies weekly with bounded pull-request volume.
- [x] CI runs a production-only dependency audit in addition to all Node tests.
- [ ] Native local PostgreSQL is optional and remains uninstalled because Windows package installation requires administrator access and Chocolatey dependency resolution failed.

## Next Packages

1. **Test-data enforcement**
   - Add explicit test-company classification.
   - Reject test transactions for live companies at shared order, inbound, inventory, user, and kitting boundaries.
   - Add unit tests for every protected transaction type.

2. **Scheduler and import idempotency - completed locally**
   - Database-backed claims allow only one application instance to run an integration sync.
   - Stale claims become recoverable after 30 minutes and can only be released by their owner.
   - External order IDs are serialized and rechecked before WMS order creation.
   - Import identity is recorded before auto-release or notification work begins.
   - Per-order savepoints prevent one failed external order from invalidating the remaining batch.

3. **Least-privilege and configuration hardening**
   - Change new-user database role defaults to warehouse worker.
   - Move automation-owner and forbidden-sender settings to environment configuration.

4. **Email transaction reliability**
   - Add an outbox/retry model so business commits and email delivery are recoverable.
   - Keep human-readable document references in all delivery logs.
   - Add reconciliation for accepted-provider messages and failed audit writes.

5. **Dependency upgrades**
   - Upgrade Express/body-parser/qs within compatible versions and rerun all tests.
   - Test Nodemailer 9 separately because the security fix requires a major upgrade.
   - Verify SMTP, Resend, attachments, BCC privacy, and password-reset delivery before deployment.

6. **Operational tooling**
   - Replace one-off production scripts with authenticated preview, approval, idempotency, and audit screens.
   - Add background-job history, retries, failure queues, and operator alerts.

7. **Billing automation**
   - Reconcile billable events against completed warehouse operations.
   - Require review and approval before invoices or billing emails are produced.

8. **Monitoring and EDI readiness**
   - Monitor login, order release, task transitions, shipping, email, Shopify, and routing appointments.
   - Continue partner profiles, document validation, acknowledgements, and EDI exception queues.

## Current Dependency Audit

- Three moderate advisories affect Express/body-parser/qs.
- One high advisory group affects the installed Nodemailer version.
- Automatic forced upgrades are intentionally paused until compatibility tests are added.
