# WMS365 User Action Performance Audit

Reviewed: 2026-11-14 (America/New_York)

## Objective

Make routine warehouse and customer actions feel immediate while preserving tenant and warehouse isolation, transaction integrity, permissions, documents, email, billing, integrations, audit history, and current data. McMaster-Carr is used only as a workflow-speed benchmark: immediate search, dense navigation, direct record access, and minimal interruption. No competitor code, copy, layout, or protected asset is used.

Official benchmark reviewed: https://www.mcmaster.com/ on 2026-11-14.

## Interaction Budgets

| User-visible action | Target | Blocking threshold |
| --- | ---: | ---: |
| Button visual response | 50 ms | 100 ms |
| Local filter/search feedback | 50 ms | 100 ms |
| Cached list or record display | 100 ms | 250 ms |
| Warm list API | 300 ms median | 750 ms p95 |
| Record drill-in API | 300 ms median | 750 ms p95 |
| Save/status acknowledgement | 500 ms median | 1,000 ms p95 |
| Initial authenticated shell, compressed | 750 ms median | 1,500 ms p95 |
| Document preview start | 500 ms | 1,000 ms |
| Download response start | 300 ms | 750 ms |

## Current User-Action Map

Static inventory on 2026-11-14 found 694 buttons across five user surfaces. Of these, 676 have a verifiable form, inline, ID, data, or delegated-class action hook. Eighteen require correction or browser-runtime confirmation; they are intentionally reported as audit failures until mapped. The inventory also found 556 event-listener registrations and 151 direct endpoint references across 2,602,440 bytes of HTML application source.

| Surface | Action path | Current implementation | Performance risk | Priority |
| --- | --- | --- | --- | --- |
| Warehouse shell | Sign in -> `/api/app/me` -> `/api/state` -> render all modules | One 1.9 MB HTML application and one broad state response containing inventory, counts, tasks, masters, billing, devices, and metadata | Large parse/compile cost and unnecessary data before the chosen module is known | critical |
| Dashboard | Open dashboard -> render from global state -> refresh alerts/tasks | Reuses state but background refreshes may overlap with module requests | Request fan-out and repeated full renders | high |
| Sales orders | Open list -> scoped order API -> ship-to refresh -> task/email refresh | Order requests are deduplicated and short-lived cached; related refreshes continue in background | List payload includes lines/documents/shipment/print data for every visible order | high |
| Sales order detail | Click order -> detail API -> lines, documents, shipments, allocations, locations, tracking | Correctly scoped but composed from many sequential database round trips | Slow drill-in under database latency; repeated data already present in list payload | critical |
| Purchase orders/inbounds | Open list -> inbound API; open record -> detail/documents/status actions | List refresh includes a fallback second request when scoped response is empty | Potential duplicate request and broad document payload | high |
| Inventory | Open inventory -> global state rows -> client render/filter | Full inventory is loaded into the shell and persisted in the local application cache | Large payload, parsing, memory, and rerender cost as inventory grows | critical |
| Items/locations | Open master list -> global state -> bounded render | Rendering is bounded, but full master data is still transferred and parsed | Network and parse cost remains proportional to global accessible data | high |
| Picking/mobile | Queue -> assigned task/order APIs -> scan/status actions | Scope is server enforced; task reads are separate from shell state | Repeated task/order reads and mobile network latency | high |
| Documents | Preview/download -> authenticated document route -> browser blob/window | Access is server enforced and previews avoid unnecessary downloads | Large files can be buffered in memory; no measured response-start budget | medium |
| Reports/exports | Click export -> server JSON/CSV or client-side CSV -> browser download | Several exports build complete files in browser memory | Large datasets delay first byte and can freeze the page | high |
| Customer portal shell | Sign in -> ten parallel APIs -> render | Parallel loading avoids a serial waterfall | Every capability loads at login, including lists the user may not open | critical |
| Customer order/inbound entry | Open form -> item/address/readiness requests -> save/release | Correctness gates are server authoritative | Repeated lookup payloads and broad item catalog transfer | high |
| Health/readiness | `/api/health` -> pool connection -> readiness checks | Candidate consolidates six database round trips to two and exposes phase timing | Production still uses the prior probe until sandbox promotion | high |

## Optimization Sequence

### Phase 1 - Instrument and remove obvious round trips

1. Emit `Server-Timing` for shell state, sales-order list/detail, inbound list/detail, inventory, tasks, documents, and exports.
2. Record sanitized route name, role class, response size, database duration, and total duration. Never log query text, customer data, addresses, SKUs, document names, or credentials.
3. Consolidate health readiness checks and expose connection/query timing.
4. Remove duplicate list fallbacks and prevent overlapping refreshes with one in-flight request per scope.
5. Add automated budgets that fail sandbox verification when a primary action exceeds its threshold.

### Phase 2 - Route-scoped loading

1. Replace the all-module `/api/state` bootstrap with a small session/shell payload.
2. Load inventory, items, tasks, billing, devices, and master data only when the user opens that module.
3. Keep the visible module stable while background data refreshes; do not blank the screen for refresh.
4. Return order/inbound list summaries first and fetch full lines, documents, allocations, and tracking only on drill-in.
5. Paginate and search on the server for large inventory, item, order, inbound, task, and billing collections.

### Phase 3 - Network and browser delivery

1. Compress HTML, JavaScript, CSS, JSON, CSV, and text responses with Brotli/gzip where supported.
2. Split the 1.9 MB warehouse application by module so the active workflow is parsed first.
3. Use immutable cache headers only for versioned static assets. Keep authenticated HTML, JSON, and customer documents private and revalidated.
4. Prefetch a record on pointer hover, keyboard focus, or idle time only after access scope is known; cancel stale prefetches.
5. Stream large CSV/PDF responses and avoid building multi-megabyte files in browser memory.

### Phase 4 - Database paths

1. Profile each primary route in isolated sandbox with realistic designated-test-company cardinality.
2. Consolidate order detail reads where transaction consistency permits and eliminate repeated list/detail data.
3. Add or adjust indexes only from measured `EXPLAIN (ANALYZE, BUFFERS)` evidence in sandbox.
4. Move idempotent backfills and reconciliation outside web-process readiness; schema migrations remain explicit, bounded, and rollback aware.
5. Split legacy startup DDL from ordinary application startup so unchanged deployments do not reconcile the full schema.

## Local Files and Offline Data

- Browser downloads remain user initiated and use normal secure document routes.
- Do not persist customer documents, addresses, orders, inventory, billing, or credentials in unencrypted browser storage merely to gain speed.
- The mobile/native application may keep a minimal encrypted, user-and-warehouse-bound working cache with expiry, revocation, versioning, and server reconciliation.
- Safe local cache candidates are versioned UI assets, non-sensitive lookup labels, the active user's preferences, and explicitly downloaded reports/documents.
- Local data must never broaden tenant or warehouse access, outlive logout/revocation, or become authoritative for quantities or status transitions.

## Acceptance

- Exercise every primary navigation item and command button as the designated sandbox roles.
- Capture click-to-feedback, API duration, database duration, payload bytes, render completion, and error outcome.
- Prove denied company/warehouse actions remain denied and do not prefetch hidden data.
- Confirm inventory/order/inbound writes remain atomic and documents/emails/billing/jobs are unchanged.
- Complete fresh-database verification, authenticated role workflows, a 10-minute soak, and exact commit promotion before production.
- Run `node scripts/audit-user-action-performance-map.js`; every remaining unresolved control must be wired, converted to non-interactive presentation, or explicitly removed. Do not suppress unresolved controls in the audit.
