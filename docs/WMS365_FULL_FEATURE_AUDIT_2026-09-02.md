# WMS365 Full Feature Audit - September 2, 2026

## Outcome

The current production build passed the complete release, browser, database-control, fresh-install, security, and live-health verification cycle. No active customer-portal regression was found after deployment.

## Verified Coverage

- 320 Node tests passed across authentication, tenant isolation, warehouse isolation, roles, inventory locking, receiving, putaway, allocation, picking, staging, shipping, kitting, documents, billing, integrations, routing, password recovery, mobile work, and user-facing errors.
- 12 centralized access-control assertions passed across warehouse and customer resources.
- 5 customer-portal browser journeys passed across desktop navigation, mobile navigation, order entry, selected-warehouse inventory, and selected-warehouse search.
- Billing and Accounting browser audit passed.
- Customer-guide screenshot validation passed.
- Production dependency audit reported zero known vulnerabilities.
- Rollback-only test-company flow passed single-warehouse order, split-warehouse order, pick, stage, ship, inbound receipt, putaway, cycle count, BOL generation, and sole-warehouse legacy stock visibility.
- Isolated fresh-database boot passed and created inventory ledger, warehouse shipment, background job, partner approval, and storage billing snapshot tables before removing the temporary schema.
- Live production health reported database ready, schema initialized, and desktop/mobile entry routes ready.
- Live customer portal loaded without browser warnings and displayed inventory only for the active warehouse.

## Corrected During Audit

1. Fresh database initialization created the access-restriction audit table before its `app_users` dependency. The dependency now exists first.
2. The health endpoint could report ready while schema initialization was still running. Health now remains unavailable until the full schema and both warehouse entry routes are ready.
3. The release process did not have one command covering browser and guide checks. `npm run check:release` now runs the complete local release gate.
4. Database verification now includes a real rollback-only check for legacy stock in a single assigned warehouse, preventing a repeat of the Pretty Gutsy item-selection regression.

## Open Data Exceptions

- Eight completed Pure Foods outbound orders do not currently have matching billing events: ORD-000457, ORD-000458, ORD-000460, ORD-000471, ORD-000472, ORD-000485, ORD-000486, and ORD-000487.
- Billing activity email remains paused as configured. The missing events require reviewed historical reconciliation and should not be generated automatically without approval.

## Product Gaps

Current product research still classifies these as incomplete rather than regressions:

- Critical: EDI certification readiness is partial.
- Critical: scan-to-pack and cartonization are not complete.
- Critical: forward-pick replenishment is not complete.
- High: wave and batch picking are not complete.
- High: shipping automation, parcel rates/labels, and dock scheduling are partial.
- High: a full RMA inspection and disposition workflow is not complete.
- Medium: cycle-count maturity, labor analytics, and billing automation need further work.

## Release Commands

- `npm run check:release`
- `railway run npm run check:database`
- `railway run npm run check:fresh-database`
- `npm run research:wms`
- `npm audit --omit=dev --audit-level=high`

## Infrastructure Follow-Up

Railway reports that `railway.json` Config as Code is deprecated and remains supported only until December 1, 2026. Migrate it to `.railway/railway.ts` in a controlled release before that date.
