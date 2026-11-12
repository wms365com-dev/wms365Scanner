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
