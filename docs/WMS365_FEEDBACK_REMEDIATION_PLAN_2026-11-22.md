# WMS365 Feedback Remediation Plan — November 22, 2026

Source reviewed: `C:\Users\T470\Desktop\builder-notes-2026-11-22 (1).md` (38,418 bytes, modified November 22, 2026 at 9:49 PM Eastern).

This plan treats repeated defects as release-gate failures, not isolated UI bugs. A fix is complete only after a targeted regression test, the adjacent workflow suite, the complete release gate, a designated-test-company production run, reload/read-back verification, and a post-deployment check on the exact deployed build.

## Safety and scope corrections

- Never mutate REVON PHARMA LTD or the named live orders. REVON checks are read-only.
- Repository policy overrides the feedback file's older test-company direction. Transaction tests must use exact designated company **CODEX PORTAL SYSTEM TEST**, owner account ID **1510**, after `scripts/designated-test-company.js` verifies its exact ID, name, and active state. Do not select any company by a fuzzy `CODEX` or `TEST` match.
- No real customer email, carrier purchase, Shopify write, billing send, or other external side effect is part of automated acceptance. Email acceptance uses an isolated controlled mailbox and requires explicit approval before sending.
- Preserve the Dynamics vocabulary and list-to-card flow. No framework rewrite is required for this remediation.
- The current worktree contains extensive unrelated changes. Implement each phase on a clean, reviewed branch or worktree and stage only named files.

## What the feedback proves

### Confirmed open or partial defects

1. **P0 #20:** native confirmation dialogs are invisible or mouse-inaccessible across Mark Shipped, Cancel, Duplicate, and Archive.
2. **P0 #18:** shipment closeout succeeds through Enter but is blocked by the same confirmation defect; pallet prefill and packing-slip quantity behavior need deterministic verification.
3. **P0 #17:** Company Profile does not auto-load and may show blank contact/address values without distinguishing “not loaded” from “empty”.
4. **P1 #11:** dirty sales-order forms have no discard guard; Back/Escape behavior is unreliable; Requested Ship Date is hard to enter.
5. **P1 #15:** draft removal policy is unclear; Archive exists, Delete does not.
6. **P1 #14:** Sales Orders list chooses Ship To Company ahead of the more useful contact name.
7. **P1 #19:** company switching can leave a partial one-order list because render and company-scoped fetch completion are not coordinated.
8. **P1 #10 remainder:** warehouse scope flashes empty and order synchronization regressed to 30–90 seconds.
9. **Cross-cutting dead controls:** Print Pick Ticket on some statuses/orders, Contact Support, Email Support, Reset My Password, and list sorting lack reliable visible outcomes.
10. **Workflow nits:** Total Pallets persistence, pre-save allocation disagreement, blank-form flash after Release, stale error banners, and duplicate document uploads.

### Root cause found in current source

`index.html` still uses browser-native `window.confirm()` in the exact affected paths, including Duplicate (`duplicateWarehouseSalesOrder`), Cancel (`deleteWarehouseSalesOrder`), shipment closeout (`confirmPortalShipmentCloseoutReview`), short-shipment decisions, reprint decisions, and several adjacent workflows. Repairing action handlers without replacing and testing this shared dependency allowed the same defect to recur across actions.

Shipment closeout also mixes validation, multiple confirmations, upload waiting, request submission, and button busy state in one path. That makes cancellation, a covered dialog, or an asynchronous failure capable of leaving misleading “Marking shipped…” feedback.

## Phase 0 — establish reproducible evidence before changing code

1. Add a Playwright reproduction spec that opens each affected action on fixture data and proves the current failure by mouse.
2. Capture computed visibility, bounding boxes, hit target, active element, overlay stack, `aria-modal`, and screenshot for each dialog.
3. Add instrumentation around company switch: selected company/warehouse IDs, request start/end, response row count, render generation, and stale-response discard. Log identifiers and timings only—no customer/order payloads.
4. Add a performance trace for cold reload, warehouse restoration, company switch, Refresh, and list render.
5. Record the failing baseline in a machine-readable issue matrix. Do not weaken tests to match current behavior.

Acceptance: every reported repeat issue has a failing automated reproduction or is classified as data-dependent/read-only with an exact inspection query.

## Phase 1 — P0 shared confirmation and shipment closeout

### 1A. Replace native confirmation with one tested application dialog

Implement one Promise-based confirmation service in `index.html` (extract to a shared module later only if the current build pipeline supports it safely):

- visible centered panel and backdrop with an explicit high stacking layer;
- semantic `role="dialog"`, `aria-modal="true"`, labelled title and description;
- initial focus on the safe/cancel action;
- Tab/Shift+Tab focus trap;
- Escape cancels without acting;
- backdrop click policy is explicit and tested;
- confirm button works with mouse, touch, Enter, and Space;
- invoking control regains focus on close;
- double click/Enter produces one resolution only;
- destructive actions use clear labels and styling;
- a busy action cannot open a second dialog.

Migrate all order-page confirmations together: Mark Shipped, Cancel, Duplicate, Archive/Reopen, short shipment, investigation hold, and reprint. Inventory, inbound, password, logout, and backup confirmations then migrate in the same change or are covered by a tracked follow-up before release; leaving mixed native/custom behavior would retain the root risk.

Targeted tests:

- new `warehouse-confirmation-dialog.spec.js` for state and single-resolution behavior;
- new Playwright visual/interaction spec at desktop and phone sizes;
- mouse-only, keyboard-only, Escape, focus-return, overlay/hit-test, rapid-double-submit, and second-dialog rejection tests;
- regression checks for every migrated action label.

### 1B. Make Mark Shipped a deterministic state machine

Split shipment closeout into explicit states: `idle → validating → review → submitting → succeeded|failed|cancelled`.

- Do not set “Marking shipped…” until after the final confirmation resolves true.
- Every cancel/error returns to `idle`, restores the button, and displays a specific message.
- Prevent duplicate submission with one idempotency key retained across an uncertain retry.
- Prefill Existing Pallets from staged pallet data and show the source.
- Show parsed packing-slip quantity beside system shipped quantity; do not report a mismatch when the values are equal.
- List missing evidence categories by name.
- Show a final summary of line quantities, pallet deduction, inventory impact, billing event, and whether an email will be queued.
- Preserve saved evidence and form values across failed validation and reload.

Targeted tests:

- extend `shipment-closeout-requirements.spec.js` for pallet prefill, equal quantities, named missing documents, cancellation, error recovery, and idempotency;
- Playwright mouse-only shipment from STAGED to SHIPPED using designated test-company fixtures;
- reload/read-back: status SHIPPED, counts updated, inventory ledger deducted once, task closed once, billing event once, audit event once;
- negative tests: wrong company, wrong warehouse, insufficient role, missing proof, short ship, repeated submit, request timeout, and email provider failure;
- email failure must not roll back shipment and must produce a visible, retryable notification record without exposing recipients.

P0 exit gate: four order confirmations pass by mouse and keyboard, and a fresh designated-test-company order completes Draft → Released → Picking → Picked → Staged → SHIPPED by mouse alone. No live order is modified.

## Phase 2 — P0 Company Profile integrity

1. Auto-load the selected company profile when Master Data opens or the active company changes.
2. Separate loading, loaded-empty, loaded-with-data, unauthorized, and error states.
3. Bind every identity/contact/address field to the same company-scoped record contract.
4. Keep fields editable where the role permits; disable with a visible reason otherwise.
5. Add a load token/generation so an older company response cannot overwrite the newly selected company.
6. Save with optimistic concurrency or a server version check so a blank/stale form cannot overwrite newer data.

Tests:

- unit/source contract for every profile field;
- Playwright auto-load and switch-company race test;
- designated-test-company edit/save/reload/read-back of one synthetic contact field, then restore within the same controlled test transaction where supported;
- read-only database comparison for REVON to determine whether blank fields are truly null—never save REVON during QA;
- role and cross-tenant negative tests.

## Phase 3 — P1 form safety and draft lifecycle

### Unsaved changes (#11)

- Track a normalized baseline after load/save and compute dirty state from meaningful fields.
- Guard Escape, Back, list/card navigation, company switch, warehouse switch, browser Back, and `beforeunload`.
- Use the shared confirmation dialog with **Keep editing** as the safe default.
- Add a normal typed/date-picker path for Requested Ship Date.
- Clear dirty state only after authoritative save/read-back, not when submit begins.

### Draft removal policy (#15)

Choose and document one policy before coding:

- recommended: **Archive is the only removal path** because order numbers and audit history must be retained;
- rename/position it as **Archive Draft**, explain that it leaves the active list, and expose archived filters/history;
- do not add hard delete unless business/legal policy explicitly requires it and all dependent allocations, tasks, documents, billing, and audit records have a safe cascade/retention design.

Tests: dirty Escape/Back/navigation matrix; Keep editing preserves all values; Discard returns without save; saved form does not prompt; Archive removes only the designated test draft from active views and remains in history.

## Phase 4 — P1 list correctness, scope, and performance

### Ship To display (#14)

Define one display formatter: contact/recipient name first; company second when distinct; city/state below. Use it consistently in active, shipped, search, print, and portal views. Verify ORD-002471 read-only after deployment.

### Company-switch race (#19)

- Key list cache by company + fulfillment warehouse + filters.
- Use `AbortController` and a monotonically increasing request generation.
- Clear or mark prior rows stale immediately; show a skeleton until the current scoped fetch completes.
- Discard responses whose generation/scope no longer matches.
- Refresh must bypass stale cache and wait for the current request.
- Show `Showing X of Y`, last refreshed time, and a retry action on partial/error responses.

### Warehouse persistence and 30–90 second regression (#10)

- Restore permitted company/warehouse scope from local session state before first list render, then validate it against the authenticated server response.
- Never display “No outbound warehouse” while validation is pending; show a neutral loading label.
- Profile server endpoints and payload sizes; paginate lists (50 rows) and avoid refetching the complete platform state for an order-list refresh.
- Add performance marks and CI budgets: scope label stable on first paint, list usable under 5 seconds on the production test account, no stale one-row intermediate state presented as complete.

Tests: rapid A→B→A company switching with delayed/out-of-order mocked responses; warehouse switching; Refresh during in-flight load; browser reload; direct order URL → list; empty/partial/error/retry states; tenant and warehouse isolation; performance trace on the deployed build.

## Phase 5 — dead controls and workflow nits

Apply the app-wide rule: every rendered control must perform its action, display a busy state, or display why it is unavailable.

- **Print Pick Ticket:** test every allowed status; do not count a self-closing blank tab as success. Create the document before opening/printing, show preview/queue outcome, and preserve print-event idempotency.
- **Support controls:** connect Contact/Email Support to the existing feedback/bug queue, or visibly disable with setup guidance. Never silently discard.
- **Reset My Password:** show queued/sent/failed status without revealing account existence; audit and rate-limit requests.
- **Sorting:** use one stable comparator with null handling and accessible direction state; test all list variants.
- **Total Pallets:** include in draft serialization, server validation, database mapping, response, reload, duplicate, and BOL prefill.
- **Availability:** reuse one server calculation for unsaved preview and saved allocation; show its timestamp/scope and revalidate on save/release.
- **Release transition:** preserve the current document until the saved response is applied; never flash a blank New Sales Order form.
- **Messages:** clear order-scoped banners when order identity changes; retain only messages explicitly marked global.
- **Document deduplication:** hash file bytes server-side and enforce an order/category/hash uniqueness policy; same filename with different content must remain reviewable, and uncertain retries must be idempotent.
- **Duplicate PO warning:** company-scoped exact normalized PO check with a configurable warn/block policy and explicit override audit.

Each item gets a focused Node test plus a Playwright interaction test where the defect is visual or timing-dependent.

## Phase 6 — P2 clarity after reliability

Only after P0/P1 gates pass:

- explain dashboard count sources and make each count drillable;
- consolidate duplicate create/navigation actions and apply role/feature guards;
- explain Warehouse Login versus Customer Portal in Access Center;
- align “Warehouse Home” guide wording with the actual screen label;
- add loading skeletons and consistent empty/error states using the existing Dynamics-shaped UI.

## Separate roadmap — do not mix with the defect release

The feedback's IMP-1 through IMP-18 are valuable but must not expand the defect patch. Mixing BOM/kits, waves, billing, lots, returns, or mobile scanning into the confirmation/list reliability release would multiply migration and inventory risk.

Recommended roadmap after reliability certification:

| Priority | Capability | Classification | Dependencies and acceptance focus |
| --- | --- | --- | --- |
| critical | Scan-to-pack/cartonization | gap | correct carton contents, weight/dimensions, wrong-SKU blocking, mobile scan certification |
| critical | Replenishment | partial | min/max rules, deduplicated warehouse tasks, tenant/warehouse scope |
| high | Work Orders/BOM/kits | existing kitting partial; major expansion | versioned BOM, component reservation, transactional consume/receive, cost roll-up, lot/expiry and warehouse isolation |
| high | Wave/batch picking | gap | tote/cart identity, scan confirmation, cross-order/customer isolation |
| high | Returns/RMA | gap | authorization, receipt, quarantine/disposition, inventory ledger and billing |
| high | Shipping automation | partial | address validation, routing rules, rate/label providers, retry/audit history |
| medium | Billing automation | partial | idempotent event queue, approval, export and reconciliation |
| medium | Cycle counting | gap | blind count, recount/approval, immutable adjustments and mobile workflow |

The required `npm run research:wms` audit was refreshed on November 22, 2026 using feature metadata only. It reports 6 partial capabilities and 5 gaps; detailed output is in `outputs/product-intelligence/wms-feature-gap-audit.json`.

## Test and release ladder for every phase

1. **Static/source checks:** `node --check server.js`; targeted Node specs; HTML inline-script syntax extraction/check.
2. **Targeted regression:** new test must fail before the fix and pass after it.
3. **Adjacent regression:** order, inventory locking, shipment closeout, print, billing, email, portal, role, tenant, and warehouse-isolation suites affected by the change.
4. **Complete local gate:** `npm run check:release`.
5. **Database gates:** `railway run npm run check:database` and `railway run npm run check:fresh-database` for schema/high-risk workflow changes. These use the repository's rollback/isolated-schema safeguards.
6. **Designated test-company browser run:** verify exact company ID/name first; use unique `TEST-` records; no external sends.
7. **Reload/read-back:** close/reopen, full reload, direct URL, list return, and a second authorized session where relevant.
8. **Deploy exact commit:** record Git SHA, Railway deployment ID, build stamp, and migrations.
9. **Post-deployment:** public health, authenticated designated-test-company targeted run, error/5xx logs, performance budget, and REVON read-only checks only where needed.
10. **Rollback readiness:** additive migrations first, feature flag for high-risk UI/workflow changes, documented rollback that does not reverse completed inventory transactions.

## “Works this time” completion standard

An issue may be marked fixed only when all of the following are attached to its checklist row:

- root cause and affected shared component;
- code commit and exact deployed build;
- failing-before/passing-after automated regression;
- mouse and keyboard evidence for interactive defects;
- designated-test-company saved-state read-back;
- tenant, warehouse, and role negative tests;
- adjacent workflow results;
- no new application errors or HTTP 5xx in the release window;
- performance comparison where timing is involved;
- explicit external gates (real email inbox, physical printer, carrier, etc.) left open unless actually verified.

## Recommended implementation order

1. Phase 0 reproductions and measurements.
2. Phase 1A shared confirmation component and all confirmation migrations.
3. Phase 1B Mark Shipped state machine and closeout tests.
4. Phase 2 Company Profile integrity.
5. Phase 3 unsaved changes and archive policy.
6. Phase 4 scope/list correctness and performance.
7. Phase 5 dead controls and workflow nits.
8. Phase 6 clarity/polish.
9. Start improvement roadmap only after the reliability release is certified.
