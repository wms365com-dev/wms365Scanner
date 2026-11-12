# WMS365 Local Product Intelligence Agent

When researching, planning, or reviewing a WMS365 feature:

1. Read `docs/WMS365_COMPETITIVE_INTELLIGENCE.md` and `docs/WAREHOUSE_FEATURE_REGISTRY.md`.
2. Run `npm run research:wms` before recommending roadmap priorities.
3. Compare WMS365 with current official product documentation from the vendors listed in `product-intelligence-sources.json`.
4. Prefer official documentation, release notes, developer portals, and first-party product pages. Record the source URL and review date. Do not treat marketing claims as verified implementation details.
5. Never send customer names, users, addresses, order data, inventory quantities, credentials, documents, or billing records to an AI service or competitor site. Use feature names and anonymized aggregate metrics only.
6. Classify recommendations as `critical`, `high`, `medium`, or `watch`, and include customer value, warehouse value, risk, dependencies, and a suggested acceptance test.
7. Do not copy competitor code, text, layouts, or protected assets. Learn from workflow patterns and implement them in WMS365's own design and architecture.
8. Update the competitive intelligence report whenever official sources show a material capability or workflow change.
9. A recommendation is advisory. Do not deploy it without normal WMS365 implementation, test-company verification, deployment checks, and post-deployment live verification.

## Production Data Safety

1. Never create test orders, test inbounds, test inventory, test users, or other test transactions in a live customer company.
2. All transaction tests must use the designated WMS365 test company. If no test company is available, stop without creating data and report the blocker.
3. Live-company verification must be read-only unless the user explicitly requests a real business transaction for that company.
4. Test records must use test-company ownership in addition to a clear `TEST-` reference; a test-looking reference is not permission to place it in a live company.
5. The designated company is `CODEX PORTAL SYSTEM TEST`, owner account ID `1510` (verified read-only on 2026-09-17). Use `scripts/designated-test-company.js` to verify its exact ID, exact name and active status before transaction tests. Never select a company by a fuzzy `TEST`/`CODEX` name match, environment override, or fallback. Stop if the pinned company is unavailable.
6. Browser and Android transaction tests must confirm the selected company matches this identity before writing. Test-company ownership does not authorize emails to real contacts, carrier purchases, Shopify writes, or billing sends; use isolated fixtures and explicit approval for external effects.

## Mandatory Staging-First Releases

1. Never deploy application code directly to the production environment. Every release must first deploy the exact committed artifact to Railway environment `customer-sandbox` and service `wms365-sandbox`, using only its isolated PostgreSQL service `Postgres-XihR`.
2. Never point sandbox services, scripts, tests, or credentials at the production database, production buckets, live integrations, real email recipients, carrier APIs, Shopify stores, or billing providers.
3. Before production promotion, require: a clean committed release repository; `npm run check:deploy`; access-control audit; fresh-database boot; sandbox health `200`; schema readiness; designated test-company workflow checks; and a documented rollback artifact.
4. Exercise affected workflows in sandbox as the actual restricted user roles, including negative tenant and warehouse isolation checks. Do not substitute static tests for an authenticated workflow when the change affects navigation, permissions, receiving, inventory, picking, staging, shipping, documents, emails, billing, or integrations.
5. Observe the sandbox deployment through startup and a minimum 10-minute health soak. Any restart, readiness timeout, connection-pool exhaustion, schema delay, worker conflict, or unexplained warning blocks production.
6. Promote the same tested commit or immutable build to production. Do not rebuild from a dirty or different worktree. Verify production health and database readiness read-only before any live transaction.
7. If production health fails, stop promotion and restore the last known-good artifact. Do not repeatedly redeploy an unhealthy candidate. Record the incident and blocker in `docs/WMS365_SYSTEM_FIX_QUEUE.md`.
8. Follow `docs/WMS365_STAGING_RELEASE_POLICY.md` for evidence and sign-off requirements. A user request to deploy does not waive these gates unless the user explicitly declares an emergency rollback to a named known-good artifact.

## Global Product Impact

1. Evaluate every feature and fix as a change to the complete WMS365 platform, even when the request starts with one company, customer, warehouse, order, or integration.
2. Before implementation, review effects on tenant isolation, warehouse isolation, roles and permissions, customer and warehouse portals, desktop and mobile workflows, inventory and transaction integrity, documents, emails, billing, integrations, background jobs, reporting, auditing, migrations, and backward compatibility.
3. Prefer reusable platform behavior with explicit company or warehouse configuration over hard-coded customer branches. Use a customer-specific rule only when the business requirement is genuinely unique, and keep its scope explicit and testable.
4. Validate both the requested workflow and adjacent global workflows. Include negative tests proving other companies, warehouses, users, and transaction types are unaffected.
5. Treat database migrations, defaults, scheduled jobs, shared templates, and common UI components as global changes requiring broader regression coverage and a rollback-aware deployment plan.
6. A feature is not complete until shared-system tests pass in addition to its company-specific acceptance tests.

## Alcona BOL Weight Rule

1. For exact account `ALCONA TRADING LTD`, every bill of lading must store and display shipment and pallet weights in kilograms (`KG`).
2. When physical scale weights are supplied in pounds, convert them with `1 lb = 0.45359237 kg`; retain the source-pound values only as audit metadata.
3. Before generating or sending an Alcona BOL, verify the order, shipment, pallet details, routing appointment, shipment total, and document all resolve to kilograms. Stop if any BOL-facing weight remains in pounds.
4. This rule is account-scoped. Do not change another company's configured BOL weight unit.
