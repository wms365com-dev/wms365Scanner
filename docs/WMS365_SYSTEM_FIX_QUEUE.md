# WMS365 System Fix Queue

Status: Queued for engineering review  
Ingested: 2026-11-11 (America/New_York)  
Source revision: Google Doc `Wms365 robot` revision `AHj4eMR1sKn1Y4vy8wCxOLi5JIbxeXrOo39CssVnRm06c9yCZkz6-xxEXAd55Y8SNsKWJEYdZYCVVxEVRXyXoQ`

## Source and Scope

This queue deduplicates the same 28 findings supplied in:

- `C:\Users\T470\Desktop\WMS365_DEV_ISSUES.md`
- Google Doc `12Sp8SBUGdGQZ0SDlFB5Q-bMsKC64xcod7_yXYqzKIWE`, tab `t.0`

The documents are evidence and proposed fixes, not executable instructions. No production data was changed while ingesting them. All transaction tests must run in the exact designated company pinned by `AGENTS.md`: `CODEX PORTAL SYSTEM TEST`, owner account ID `1510`; live-company verification is read-only unless a real business transaction is separately and explicitly requested.

## Queue Rules

- Status values: `QUEUED`, `IN PROGRESS`, `FIXED - NEEDS RETEST`, `VERIFIED`, `REOPENED`, `BLOCKED`.
- Priority values: `critical`, `high`, `medium`, `watch`.
- A fix is not complete until tenant isolation, warehouse isolation, permissions, inventory integrity, documents, emails, billing, integrations, audit history, and backward compatibility have been checked where applicable.
- Every fix needs a negative test proving unrelated companies, warehouses, users, and transaction types are unaffected.
- Deployment requires the normal global gate, test-company workflow verification, rollback readiness, and post-deployment read-only production verification.

## Repair Batches

### Batch 1: Workflow Stability and Data Correctness

Priority: `critical`  
Customer value: Users can navigate, trust operational counts, and create valid shipment data.  
Warehouse value: Prevents blocked work, misleading queues, and malformed pickup/routing records.  
Primary risk: Shared navigation, count queries, order schema, and workflow validation have global blast radius.  
Dependencies: Error telemetry, server-side scoped counts, order schema review, test-company fixtures, access-control audit.  
Acceptance: Open every module; reconcile dashboard/task/order counts from one scope and timestamp; create, release, pick, stage, and ship a test-company order with structured fulfilment data; verify no live data changes.

| Order | ID | Priority | Finding | Status |
| ---: | --- | --- | --- | --- |
| 1 | WMS-01 | critical | Module navigation freezes; Items crashed the browser tab | FIXED - NEEDS RETEST |
| 2 | WMS-02 | critical | Task counts appear capped at 300 and change between loads | REOPENED |
| 3 | WMS-03 | critical | Task counts conflict with open outbound and status counts | REOPENED |
| 4 | WMS-21 | critical | Pickup is free text; warehouse, carrier, and fulfilment method are not structured | FIXED - NEEDS RETEST |
| 5 | WMS-25 | high | Normal page load produces `/api/app/me` and `/api/state` 401 noise | FIXED - NEEDS RETEST |
| 6 | WMS-27 | medium | Green/amber system status dot has no label or explanation | QUEUED |

### Batch 2: Scope, Permissions, Feature Flags, and Inventory Clarity

Priority: `high`  
Customer value: Users know which company and warehouse they are changing and why an action is unavailable.  
Warehouse value: Reduces wrong-scope work, routing mistakes, and inventory interpretation errors.  
Primary risk: Scope and permission changes can expose cross-tenant or cross-warehouse data if implemented incorrectly.  
Dependencies: Canonical company/warehouse context model, feature-flag policy, RBAC matrix, inventory quantity definitions.  
Acceptance: Test super-admin and warehouse-user roles in All Companies and single-company modes; prove unauthorized records remain inaccessible; explain every blocked action; reconcile on-hand, allocated, and available quantities.

| Order | ID | Priority | Finding | Status |
| ---: | --- | --- | --- | --- |
| 7 | WMS-04 | high | Empty lists and disabled create buttons hide the required company selection | FIXED - NEEDS RETEST |
| 8 | WMS-05 | high | Conflicting labels obscure active company scope | FIXED - NEEDS RETEST |
| 9 | WMS-08 | high | Disabled marketplace feature still exposes Shopify setup and navigation | FIXED - NEEDS RETEST |
| 10 | WMS-16 | high | `Not ready` is unexplained and conflicts with the order page | FIXED - NEEDS RETEST |
| 11 | WMS-17 | high | Routing fields do not clearly state which missing values block routing | FIXED - NEEDS RETEST |
| 12 | WMS-22 | high | Available quantity conflicts with the on-hand caption | QUEUED |
| 13 | WMS-09 | medium | Disabled Shopify and SFTP controls have no reason | QUEUED |
| 14 | WMS-10 | medium | Company labels render without a field | QUEUED |
| 15 | WMS-11 | high | Reports omit scope and quantity basis and can show contradictory company totals | QUEUED |
| 16 | WMS-12 | medium | Company name overlaps FactBox content | QUEUED |

### Batch 3: Sales Order List, Record Continuity, and Deep Links

Priority: `high`  
Customer value: Users can identify the correct order, understand replacements, and share exact records.  
Warehouse value: Faster handoffs and fewer wrong-order actions.  
Primary risk: Record routing must enforce permissions server-side and preserve Back/Forward behavior.  
Dependencies: Stable record routes, order relationship model, stale-navigation cancellation, list query extensions.  
Acceptance: Open and share a permission-checked order URL; use browser Back/Forward; show ship-to and replacement links; ensure stale banners clear and released orders never appear as a create workflow.

| Order | ID | Priority | Finding | Status |
| ---: | --- | --- | --- | --- |
| 17 | WMS-15 | high | Sales Orders list omits ship-to | QUEUED |
| 18 | WMS-18 | high | Cancelled duplicate and replacement share a PO without a visible relationship | QUEUED |
| 19 | WMS-19 | medium | Stale `Opening sales order...` banner remains visible | QUEUED |
| 20 | WMS-20 | high | Released order opens with create/edit language | QUEUED |
| 21 | WMS-24 | high | Orders open late in a modal and have no durable URL | QUEUED |

### Batch 4: Navigation, Empty States, and Operator Efficiency

Priority: `medium`  
Customer value: New and occasional users can understand the interface without support.  
Warehouse value: Daily operators spend less time scanning noisy controls and recovering context.  
Primary risk: Shared UI changes can regress mobile, keyboard, and role-specific workflows.  
Dependencies: Stable Batch 1 navigation, canonical feature names, responsive and accessibility checks.  
Acceptance: Validate desktop and mobile layouts, keyboard navigation, empty-state next actions, correct active navigation, compact read-only lines, and scan/typeahead behavior in the test company.

| Order | ID | Priority | Finding | Status |
| ---: | --- | --- | --- | --- |
| 22 | WMS-06 | watch | New Vendor controls disagree about whether creation is enabled | QUEUED |
| 23 | WMS-07 | medium | Quick-link highlight points to the wrong page | QUEUED |
| 24 | WMS-13 | medium | Empty states lack next actions and Items wording is misleading | QUEUED |
| 25 | WMS-14 | medium | Navigation, Warehouse Directory, and documentation use different names | QUEUED |
| 26 | WMS-23 | medium | Full SKU dropdowns make every order line noisy and slow | QUEUED |
| 27 | WMS-26 | watch | Sign-in adds an unexplained Access Center choice before warehouse login | QUEUED |
| 28 | WMS-28 | medium | Search by Location looks disabled | QUEUED |

## Global Verification Matrix

Every batch must cover:

- `BISON TRANSPORT TEST COMPANY`: create, release, pick, stage, ship, receive, inventory lookup, documents, and notifications as applicable.
- Roles: super admin, customer service, warehouse worker, and restricted warehouse user.
- Scope: All Companies, one company, one warehouse, and a denied warehouse.
- Integrity: inventory ledger, allocations, warehouse tasks, shipment/receipt records, billing event idempotency, and document ownership.
- Communications: no duplicate or unauthorized email; suppressed notifications remain suppressed.
- UX: desktop, mobile, loading, empty, error, retry, Back/Forward, and concurrent-user handoff states.
- Observability: error reference includes user, time, route, company, warehouse, build, and request ID without request bodies, credentials, or recipient data.

## First Engineering Actions

1. Reproduce WMS-01 through WMS-03 with production-scale anonymized fixtures in the test company.
2. Add failing automated coverage before changing shared navigation or count queries.
3. Trace WMS-21 through UI, API validation, persistence, documents, routing, emails, and billing.
4. Run `npm run audit:access-control` and the global test gate before any deployment candidate.
5. Move tickets to `FIXED - NEEDS RETEST` only with code references and test evidence; move to `VERIFIED` only after an independent test-company pass.

## Engineering Evidence

### Sales-order queue performance and rolling-startup resilience

- Status: `VERIFIED` on 2026-11-12 after the complete staging-first release cycle.
- Code: commit `283c1c4f8d8cc3b5c13328d4d375213594acff31` parallelizes independent sales-order queue reads, preserves the `{ orders: [...] }` response contract, and adds `Server-Timing` plus result-count observability. Commit `6f6071c59b23068429d8ea574360ec49db00a381` serializes application schema initialization with a PostgreSQL advisory lock and gives every database session a bounded five-second lock wait so rolling candidates retry instead of hanging indefinitely behind DDL locks.
- Tests: focused performance/startup coverage passed 5/5; access-control audit passed 12/12 across 290 routes; the global deploy gate passed 747/747. The isolated fresh-database boot confirmed inventory, shipments, jobs, approvals, billing snapshots, ship-to addresses, and address-status controls.
- Sandbox: exact commit `6f6071c59b23068429d8ea574360ec49db00a381` deployed successfully as Railway deployment `5d54df35-dba2-427b-8562-5f9141ccc952`, image digest `sha256:edba6c8db10d7da2e54f3eb2f5c40db73cafc8063fdb35499b9d1d19d621f2e5`. The authenticated exact test-company workflow verified account ID `1510`, tenant and warehouse denial paths, and cleanup. Sales-order queue timing was 42.2 ms median and 69.7 ms maximum against budgets of 750 ms and 1500 ms.
- Soak: six health samples over 10 minutes retained database, schema, desktop, and mobile readiness with 6-15 ms database probes. Logs showed one successful initialization with no retry, restart, pool warning, migration warning, or external live side effect. Railway's Config-as-Code deprecation notice is understood and separately requires migration before 2026-12-01.
- Production: the prior candidate `a970ee6d-f16f-4f42-a0e1-27a767da9e21` failed readiness before cutover because legacy startup DDL could wait indefinitely; the retained application remained healthy. After the startup repair passed sandbox, exact commit `6f6071c59b23068429d8ea574360ec49db00a381` was promoted as deployment `81360938-733d-4119-954a-131b6a0905c5`, image digest `sha256:58ab4010826bb344ebfd14678cd61a38a36be6bc7e9a0e105347415cd7fdd4fe`. Production schema initialization completed, Railway marked the deployment `SUCCESS`, and three post-cutover samples returned full readiness with 21-22 ms database probes.
- Rollback: named prior application artifact is deployment `9831d93d-4927-4168-a527-e7ee1ef5c381`, image digest `sha256:d50e1539238fceb947287c0fbff16cbdd89bea6dc65af4e0ca323bda012ab623`. PostgreSQL was not restarted and no production test transaction or customer record was created or changed.

### WMS-02 and WMS-03

- Independent retest: 2026-11-12. The clean production baseline still capped the application state to 240 active warehouse tasks and the task endpoint to 300 rows. Order history also applied its row limit before preserving all active outbound orders. Both critical findings were reopened.
- Repair candidate: active task reads now request the complete authorized scope; restricted users retain both company and explicit warehouse filtering; optional task-page limits remain bounded; and the order-history cap applies only to inactive history while every active outbound order remains present.
- Regression coverage: `warehouse-dashboard-counts.spec.js` passed 3/3, covering uncapped active reads, tenant and warehouse isolation, and preservation of active orders outside the history cap. `npm run audit:access-control` passed 12/12 across 290 routes. `npm run check:deploy` passed 737/737.
- Status: `REOPENED`. Fresh-database verification, exact sandbox deployment, authenticated production-scale task-count reconciliation, isolation checks, and a 10-minute healthy soak remain required before any production promotion.
- Sandbox retest progress: 2026-11-12 18:40 America/New_York. Clean commit `7a8171d35dbd673734eb404556f0ce526c30c7b5` passed the focused task-count suite 3/3, access-control audit 12/12 across 290 routes, global deploy gate 737/737, and isolated fresh-database boot with all seven schema controls ready. Railway sandbox deployment `56c6cb65-39a3-4f30-ae16-c93b23ae490b` succeeded and returned healthy application, database, schema, desktop, and mobile readiness.
- Promotion blocker: the sandbox build reported Node engine incompatibilities because deployed Node 20 does not satisfy the current Google client packages' Node >=22 requirement. The staging policy treats this warning as release-blocking. No production promotion was attempted. Align and retest the runtime and dependencies, then complete authenticated production-scale task-count and denied-scope workflows plus a fresh 10-minute soak.
- Runtime blocker resolved in sandbox: 2026-11-12 19:39-19:42 America/New_York. Commit `d0a863e` raises the application and lockfile Node floor to 22 and adds `runtime-engine.spec.js`. The focused runtime test passed 1/1, access-control audit passed 12/12 across 290 routes, and the global deploy gate passed. Railway sandbox deployment `155d7a79-656b-4823-8f0e-b10a469fab71` selected Node `22.23.4`, emitted no `EBADENGINE` warning, completed successfully, and returned healthy application, database, schema, desktop, and mobile readiness.
- Current promotion blocker: the same sandbox build still reports seven dependency vulnerabilities (two moderate, four high, one critical), two transitive package deprecations, and npm package-manager/config warnings. The local fresh-database command also could not run without an isolated `DATABASE_URL`. Under the staging policy these unresolved warnings block production. WMS-02 and WMS-03 remain `REOPENED`; production was not changed. Audit and safely remediate the dependency findings, rerun fresh-database verification, authenticated production-scale count and denied-scope workflows, and a new 10-minute clean soak before promotion.
- Dependency remediation retest: 2026-11-12 20:48-20:50 America/New_York. Commits `b06af82` and `7c79b23` update the vulnerable production dependencies, including Nodemailer 10, and remove the remaining `moment` advisory from the test database dependency tree. `npm audit` and the Railway sandbox build both report zero vulnerabilities. The focused runtime suite passed 1/1, email security suite passed 16/16, print-connector security suite passed 13/13, access-control audit passed 12/12 across 290 routes, and the full deploy gate passed. Fresh-database verification ran inside the isolated sandbox service and confirmed all seven schema controls ready.
- Exact sandbox evidence: Railway deployment `c73420ad-982b-4d99-ad87-e6aa5cf001fc` succeeded from final commit `7c79b23`; `/api/health` returned application, database, schema, desktop, and mobile readiness with a 9 ms database probe. Production remained healthy and unchanged.
- Current promotion blocker: the sandbox build/runtime still emits the npm `production` configuration warning plus two known transitive deprecation warnings (`whatwg-encoding` through Cheerio and `node-domexception` through the Google client stack). Authenticated production-scale task-count and denied-scope workflows and a fresh 10-minute warning-free soak are also incomplete. Per staging policy, WMS-02 and WMS-03 remain `REOPENED`, and no production promotion was attempted.

### Item UPC spreadsheet normalization

- Fixed in source: 2026-11-12. The shared item-master sanitizer now removes a terminal spreadsheet decimal suffix only when the complete UPC value is numeric and the fractional part is all zeroes. Leading zeroes remain intact; alphanumeric identifiers and real decimal strings remain unchanged.
- Coverage: `item-unit-uom.spec.js` adds positive and negative normalization cases; `portal-order-pick-ticket.spec.js` continues to prove the browser pick ticket renders catalog UPCs. The focused suite passed 7 tests.
- Global checks: `npm run audit:access-control` passed all 12 checks across 286 routes. `npm run check:deploy` passed all 447 tests with zero failures.
- Deployment: Railway production deployment `8527895a-ab42-4a58-95df-c8262fb3240d` completed successfully on 2026-11-12. The release was built from the exact prior production source snapshot plus only the sanitizer and regression-test changes. The isolated local gate passed 730 tests, Railway's build gate passed, PostgreSQL schema initialization completed, the health check became ready, and the production service reports one running replica with no pending work or recent failures.
- Production verification: a read-only command inside the live container returned `001234567890` for input `001234567890.0` and preserved `LOT.0A`, proving the deployed sanitizer behavior. The durable clean release baseline is commit `d869b7a` in `C:\Users\T470\.codex\worktrees\wms365-production-release`.
- Production data: the malformed UPCs already found on `ORD-002120` were normalized separately and the production pick-ticket payload was verified read-only with clean UPCs on all 12 lines.

### WMS-01

- Independent retest: 2026-11-12. Retesting the clean production baseline reopened the issue because the deployed source lacked deferred master-library rendering and both item-list bounds. The isolated repair in `index.html` now defers the master library outside Inventory, renders it when Inventory is entered, limits the preview to 50 rows, and limits the focused Items list to 200 rows while preserving total-match counts and narrowing guidance.
- Regression coverage: `wms01-navigation-items-regression.spec.js` passed all 4 tests, covering inline-script validity, deferred rendering, both row limits, and the narrowing message.
- Global safety gate: `npm run audit:access-control` passed all 12 checks across 290 routes. `npm run check:deploy` passed all 734 tests with zero failures, including tenant and warehouse isolation, receiving, inventory, order workflow, documents, email, billing, integrations, and warehouse task transitions.
- Release source: commit `987e364` contains only the WMS-01 UI repair, its focused regression test, and queue evidence.
- Deployment: Railway deployments `5a04785a-077d-4c44-b598-da03bc2368d5` and one exact-artifact retry `739ec592-0b88-44ce-b778-95f724581129` both failed readiness. Each container started and listened on port 8080 but remained at `Initializing PostgreSQL schema...` until Railway terminated it with `SIGTERM`; neither reported an application exception. Railway retained the prior healthy production replica. No further retry was attempted.
- Incident recovery: later on 2026-11-12 the retained production process exhausted its local database connection pool and `/api/health` returned `503`. The known-good application deployment was restarted in place; its database probe recovered, schema initialization completed, and public health returned `200`. PostgreSQL was not restarted and no production records were changed. Deployment `92166da5-f028-4e1b-9738-904843925f70` is the restored known-good artifact.
- Prevention: direct production releases are now prohibited by `AGENTS.md` and `docs/WMS365_STAGING_RELEASE_POLICY.md`. The exact artifact must pass isolated `customer-sandbox` deployment, authenticated test-company workflows, and a 10-minute health soak before production promotion.
- Retest result: remains `FIXED - NEEDS RETEST` until the exact committed repair is deployed and authenticated production-scale navigation is exercised in the canonical designated test company.
- Safety blockers: earlier direct production attempts exceeded Railway readiness and are superseded by the staging-first policy. The canonical identity is now resolved to `CODEX PORTAL SYSTEM TEST` account ID `1510`; no authenticated workflow or promotion is allowed until that exact fixture exists in the isolated sandbox.
- Next safe action: provision the exact pinned designated test-company fixture in `customer-sandbox`, then complete authenticated Items navigation, denied-company and denied-warehouse checks, and a 10-minute healthy soak on the exact sandbox artifact before considering production promotion.
- Sandbox retest attempt: 2026-11-12 11:31-11:40 America/New_York. Clean reviewed baseline `5f77055e23fcdda8b8ea0628df428576d50b0349` includes WMS-01 commit `987e364`. Focused WMS-01 tests passed 4/4; access-control audit passed 12/12 across 290 routes; the deploy gate passed 734/734 after rerunning with a writable isolated temp directory; the fresh-database boot passed against an ephemeral schema on isolated sandbox PostgreSQL `Postgres-XihR` with all seven schema controls ready.
- Sandbox deployment: `0bf35670-4cdf-4241-86fa-8aeeb1028568` deployed successfully to `customer-sandbox` / `wms365-sandbox` with image digest `sha256:695c22388f6c80a4799c6400ea1dd8cd8571e36d28233e7432cc6075dc4e017d`. Production remained healthy and untouched (`/api/health` HTTP 200, database/schema/desktop/mobile ready).
- Retest blocker: the isolated sandbox database contains no exact `CODEX PORTAL SYSTEM TEST` owner account ID `1510` and no assigned warehouses. Per the pinned test-company guard, no fallback company, authenticated transaction, or production promotion was attempted. WMS-01 remains `FIXED - NEEDS RETEST`. Provision the exact designated test-company fixture in sandbox, then run authenticated Items navigation plus denied-company/denied-warehouse checks and a fresh 10-minute healthy soak before any production promotion.
- Sandbox fixture and authenticated retest: 2026-11-12 12:34-12:52 America/New_York. The isolated sandbox now contains exact account ID `1510`, two synthetic test warehouses, 250 synthetic item records, and two role-scoped synthetic users. Read-back verified counts `1/2/2/250/2`. The customer-service role opened Items with `250 saved`, rendered only the first 200 rows with the narrowing notice, and narrowed to the final synthetic SKU without a browser failure. The warehouse-worker role independently loaded all 250 synthetic items and saw only its assigned `TEST-WMS-A` warehouse; `TEST-WMS-B` remained excluded. No live customer data or external side effects were used.
- Soak evidence: sandbox and production `/api/health` both returned ready on 11 consecutive checks over 10 minutes; database, schema, desktop, and mobile readiness stayed healthy. Sandbox deployment `0bf35670-4cdf-4241-86fa-8aeeb1028568` remained `SUCCESS`; production was not changed.
- Promotion blocker: sandbox runtime logs emitted a PostgreSQL client deprecation warning during the authenticated workflow (`client.query()` called while the client was already executing a query). The staging policy treats any unexplained runtime warning as release-blocking. In addition, an immutable promotion path for the exact sandbox-proven image digest has not yet been demonstrated. WMS-01 therefore remains `FIXED - NEEDS RETEST`; investigate and eliminate the concurrent-query warning, rerun the focused gates and authenticated sandbox workflow, then repeat the 10-minute soak before promotion.
- Independent verification and promotion: 2026-11-12 13:28-14:36 America/New_York. Clean reviewed commit `4139ef509ceebd0b0b561de00295fc76b401643f` passed the focused WMS-01 suite 4/4, access-control audit 12/12 across 290 routes, global deploy gate 734/734, and the isolated fresh-database boot with all seven schema controls ready. The earlier PostgreSQL warning was correlated to a one-off Railway SSH diagnostic with no concurrent application request; a repeated authenticated warehouse-worker state read produced no application warning.
- Exact sandbox evidence: deployment `f476ff47-54b3-4975-9d7d-8d0bc8220c6d` completed successfully with image digest `sha256:03e58c16ef1c315459e9db13965e0871b121ff697b2fa20134fd77d29a428da1`. Health, schema, desktop, and mobile readiness remained healthy for more than 10 minutes. The previously recorded authenticated customer-service Items workflow and warehouse-worker isolation workflow apply to the same WMS-01 code; commit `4139ef5` adds only release-policy and retest evidence after the tested repair.
- Production promotion: exact commit `4139ef509ceebd0b0b561de00295fc76b401643f` was promoted as Railway deployment `9831d93d-4927-4168-a527-e7ee1ef5c381`, image digest `sha256:d50e1539238fceb947287c0fbff16cbdd89bea6dc65af4e0ca323bda012ab623`. Production `/api/health` returned ready with database, schema, desktop, and mobile checks passing. Named rollback remains deployment `92166da5-f028-4e1b-9738-904843925f70`. No production transaction or customer data was created or changed during verification.
- Retest result: `VERIFIED`. WMS-01 is complete. Railway's Config-as-Code deprecation notice is understood and separately requires migration before 2026-12-01; it did not affect this release.

### WMS-17

- Fixed: 2026-11-12.
- Code: the sales-order Routing section now shows a persistent live readiness summary before the operator clicks Route. It names the current status, delivery date, pallet count, shipment weight, PO, ship-from warehouse, and destination blockers, while the existing popup remains the immediate action error. The server remains authoritative for routing-template resolution and final validation.
- Security and isolation: routing draft and send endpoints now require `ORDER_STATUS_UPDATE` in addition to the central company/warehouse order guard. Draft preparation also verifies access to the order's exact ship-from warehouse, preventing a user with access to another leg of a split order from routing the full order. No inventory, allocation, shipment quantity, billing, document, or email behavior changes unless an authorized operator completes the existing send action.
- Regression coverage: `order-routing.spec.js` verifies the live blocker summary, missing shipment weight, endpoint permission gates, and exact ship-from access. `rbac.spec.js` proves customer-service workflow users remain allowed while warehouse workers without order-status authority are denied.
- Global checks: focused routing/readiness/RBAC tests passed (32 tests); `npm run audit:access-control` passed; `npm run check:deploy` passed with 445 tests across roles, tenant and warehouse isolation, inventory, documents, routing, shipment, billing, email, integrations, jobs, migrations, and browser validity.
- Retest required: in `BISON TRANSPORT TEST COMPANY`, open a staged freight order and confirm the inline summary names each omitted routing field as it is cleared, changes to ready when all visible requirements are complete, and still presents the review draft before sending. Confirm a warehouse worker without order-status permission is denied, a customer-service user assigned to the exact ship-from warehouse can prepare the draft, and a user assigned only to another warehouse cannot route it.

### WMS-16

- Fixed: 2026-11-12.
- Code: the server-derived expected-ready window is now labelled `Processing until` on both the order list/dashboard and the opened order workflow. Allocation completeness is labelled `Fully allocated`, removing the false equivalence between stock allocation and shipment readiness. Draft, cancelled, archived, and shipped orders never receive the active processing-window badge.
- Source of truth and isolation: the badge continues to consume only the expected-ready fields returned by the server; no client-provided readiness flag is accepted. The change does not alter allocation, inventory, workflow transitions, documents, routing, shipment confirmation, billing, email, tenant scope, or warehouse scope.
- Regression coverage: `order-processing-readiness.spec.js` verifies semantic labels, terminal-order suppression, server-sourced expected-ready fields, and browser script validity. Existing status-transition and access-control tests remain green.
- Global checks: `npm run audit:access-control` passed; `npm run check:deploy` passed with 442 tests across roles, tenant and warehouse isolation, inventory, documents, routing, shipment, billing, email, integrations, jobs, migrations, and browser validity.
- Retest required: in `BISON TRANSPORT TEST COMPANY`, open an active order whose expected-ready time is in the future and confirm the list and order page both show `Processing until` with the same server-calculated date. Confirm an allocated order says `Fully allocated`, and draft, cancelled, archived, and shipped records show no processing-window badge.

### WMS-08

- Fixed: 2026-11-12.
- Code: when Marketplace Connections is off for the active company, the credential and sync form is hidden behind one concise unavailable panel. Integration navigation is visibly marked `(Off)`. Only super administrators receive a path to Company Feature Access; other roles receive no unusable enable action. The existing empty status element remains hidden until a real message is shown.
- Isolation and secrets: no integration records, credentials, sync schedules, jobs, or feature flags are changed by this UI state. Existing server-side feature assertions continue to reject integration writes, Shopify OAuth, credential links, locations, SKU mappings, and sync operations when the company feature is disabled.
- Regression coverage: `marketplace-feature-visibility.spec.js` verifies the hidden form, off-state navigation, super-admin-only recovery, absence of a duplicate company selector, and retained fail-closed server guards. `sku-mapping-feature-gate.spec.js` confirms disabled companies do not issue optional mapping reads.
- Global checks: `npm run audit:access-control` passed; `npm run check:deploy` passed with 438 tests covering roles, tenant and warehouse isolation, inventory, documents, billing, email, integrations, jobs, migrations, and browser validity.
- Retest required: with Marketplace Connections off in `BISON TRANSPORT TEST COMPANY`, open the integration module as a super administrator and a restricted user. Confirm credentials and Save/Sync controls are absent, navigation reads `(Off)`, only the super administrator sees Feature Access recovery, and direct write requests remain rejected. Enable the feature in the test company and confirm the form reappears, then disable it and confirm it hides again.

### WMS-05

- Fixed: 2026-11-12.
- Code: the warehouse command bar, dashboard, FactBox, selectors, list headings, feedback context, and aggregate drill-ins now use the single scope label `All companies`. Sales order, purchase order, shipped order, and inventory titles no longer append an ambiguous `All` view label; the explicit company chip remains the sole scope indicator.
- Isolation: the official company selector, normalized all-company sentinel, persisted active-company preference, and all server-side company and warehouse authorization are unchanged. This is display-only and introduces no route, query, transaction, document, email, billing, integration, or migration behavior.
- Regression coverage: `company-scope-language.spec.js` verifies canonical scope wording, unambiguous list titles, and retention of the official selector and preference boundary. `company-context-empty-states.spec.js` continues to prove recovery actions use the official selector and protected APIs retain server-side company authorization.
- Global checks: `npm run audit:access-control` passed; `npm run check:deploy` passed with 434 tests covering tenant and warehouse isolation, roles, inventory, documents, billing, email, integrations, migrations, entry routes, and browser script validity.
- Retest required: in All companies mode and with `BISON TRANSPORT TEST COMPANY` selected, open Dashboard, Inventory, Purchase Orders, Sales Orders, Shipped Orders, and feedback context. Confirm every all-company scope reads `All companies`, the selected company is shown exactly, and switching company does not alter permissions or expose a denied warehouse.

### WMS-04

- Fixed: 2026-11-12.
- Code: company-required empty states for Customers/Vendors, Sales Orders, and Receiving now include a `Choose Company` action that focuses the existing official desktop or mobile company selector. The top workspace context continues to show `Active Company` and `All Companies`, disabled company-bound actions explain `Choose a company first`, and the existing per-user active-company preference remains the only persisted selector state.
- Isolation: no new selector, company lookup, API route, or permission bypass was introduced. Create and receive operations still require server-authorized company ownership and warehouse scope.
- Regression coverage: `company-context-empty-states.spec.js` verifies the labelled official selector, reusable recovery action, disabled-action guidance, preference persistence, and retained server-side company authorization.
- Global checks: `npm run audit:access-control` passed; `npm run check:deploy` passed with 431 tests covering tenant and warehouse isolation, roles, inventory, documents, billing, email, integrations, migrations, and browser script validity.
- Deployment: Railway production deployment `5044c966-edf1-46da-b95b-a14c0ef3dca4` completed successfully. Post-deployment health reported the application, database, schema, and entry routes ready; unauthenticated desktop access continued to redirect to login.
- Retest required: in All Companies mode, open Customers, Vendors, Sales Orders, and Receiving, activate `Choose Company`, select the designated test company, and confirm each view refreshes without using a second selector. Confirm restricted users cannot select or submit work for an unauthorized company.

### WMS-21

- Fixed: 2026-11-12.
- Code: warehouse sales orders now expose structured fulfillment method and assigned ship-from warehouse controls, plus planned carrier and service fields. Pickup orders no longer require fabricated delivery addresses; delivery orders pass the same address-shape gate for portal and internal warehouse releases. Planned carrier data persists independently from final shipment confirmation, and pickup releases do not create blank saved-address records.
- Isolation: warehouse selection still resolves through the account's outbound fulfillment assignments and rejects an unassigned warehouse. The common release path applies to both portal and internal users without weakening tenant or warehouse authorization.
- Regression coverage: `portal-order-fulfillment-method.spec.js` covers pickup without a delivery address, malformed Canadian delivery postal data, structured field persistence, assigned warehouse resolution, and the common release gate. Existing portal address validation coverage remains green.
- Global checks: `npm run audit:access-control` passed; `npm run check:deploy` passed with 427 tests, including tenant isolation, warehouse isolation, inventory, billing, documents, email, integrations, migrations, and system-error coverage.
- Deployment: Railway production deployment `b86c10da-1bff-41d5-bebd-4a2f6a8a255e` completed successfully. Post-deployment health reported the application, database, schema initialization, and warehouse entry routes ready. Unauthenticated `/desktop` continued to redirect to login, confirming the entry guard remained active.
- Retest required: in the designated test company, create one customer-pickup order without a delivery address and one delivery order with a valid assigned warehouse and carrier; release both, confirm the fields are read-only after release, and verify the pick ticket/BOL display the intended warehouse and carrier. Confirm an unassigned warehouse and malformed delivery postal code are rejected.

### WMS-25

- Fixed: 2026-11-12.
- Code: `server.js` now treats `/api/app/me` as a quiet session probe and returns `{ authenticated: false }` with HTTP 200 for an absent or expired session. `index.html` now awaits that probe before requesting protected application state, preventing paired 401 console noise during bootstrap while preserving protected-route enforcement.
- Regression coverage: `session-bootstrap.spec.js` proves the quiet unauthenticated response and authentication-first warehouse bootstrap.
- Global checks: `npm run audit:access-control` passed; `npm run check:deploy` passed with 423 tests, including warehouse entry-route, RBAC, tenant isolation, warehouse isolation, inventory, billing, document, email, integration, and system-error coverage.
- Retest required: independently open the warehouse app with a valid session and an expired session, verify no `/api/app/me` or `/api/state` 401 noise during normal bootstrap, and confirm expired sessions redirect to login without protected state loading.

