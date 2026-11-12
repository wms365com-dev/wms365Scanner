# WMS365 Warehouse Feature Registry

Last reviewed: 2026-09-04

Purpose:
- Internal feature inventory so changes do not break related workflow pieces.
- Use this before moving, renaming, hiding, or expanding warehouse features.
- This file catches hidden dependencies outside the visible screen.

### Alcona Kilograms-Only Bills of Lading
- Exact account `ALCONA TRADING LTD` requires all BOL pallet and total weights to render in `KG`, including when source scale readings arrive in pounds.
- Conversion uses `1 lb = 0.45359237 kg`; source-pound readings may remain only as audit metadata.
- The BOL formatter has an account-scoped kilograms override with a negative test proving unrelated companies retain their configured unit.
- Acceptance: an Alcona shipment recorded as 9,290 lb renders as 4,213.9 kg on the BOL; no pound total appears; a non-Alcona pound shipment remains in pounds.

## Integration Foundation

### Release Email Pick-Ticket Auto-Print
- Account-scoped through `PORTAL_ORDER_RELEASE_AUTO_PRINT_ACCOUNTS`; an empty allowlist disables the feature globally.
- A pick ticket is enqueued only after the durable warehouse release email is marked `SENT`.
- `portal_order_release_auto_prints` provides one dispatch row per order, restart-safe claims, bounded exponential retry, and a permanent audit trail.
- The warehouse printer resolver retains warehouse isolation and routes only the generated WMS pick ticket to the configured document printer.
- Uploaded order documents and shipping-label attachments are explicitly excluded from this automation. They require a separate reviewed print action.
- Initial production scope is intended for `WELLFORIA HEALTH INC` at `GW3PL-MISS`; Rancher's Chips must remain outside the allowlist.
- Acceptance: a designated test-company release email creates exactly one document-printer job; repeated scheduler runs create no duplicate; unavailable printers retry without resending email; changed/cancelled orders are skipped; other companies and all attachments produce no job.

### Rancher's Google Sheets Label Queue (candidate, not activated)
- Standalone one-way worker reads exact Rancher's Shopify-linked orders at `GW3PL-MISS` and appends newly released/picked/staged, untracked and unlabeled orders to the existing 32-column `WMS` tab.
- The WMS order code is the idempotency key across `WMS` and `Sheet1`; a PostgreSQL advisory lock serializes WMS worker instances, and appended row IDs are read back before success is reported.
- `READY` and `CHECK` follow the established package and address rules. This path does not release orders, mutate stock, purchase postage, send email, or update Shopify.
- Activation requires a narrowly shared Google Sheets service account, a supervised worker, a test-company sheet end-to-end run, deployment checks, and live readback. It is not part of the web server startup. See `docs/RANCHERS_LABEL_SHEET_SYNC.md`.

### Designated Transaction Test Company
- `CODEX PORTAL SYSTEM TEST`, owner account ID `1510`, verified active through a read-only production lookup on 2026-09-17.
- Shared local guard: `scripts/designated-test-company.js`. Database verification tools require exact ID, exact name and active status before writes; missing/changed/inactive identity stops the check without selecting another company.
- Transaction checks retain rollback behavior. No customer permissions, warehouse assignments, integrations, billing rates, schema or production records are changed by this test configuration.
- Browser/mobile tests must verify the same selected identity. External side effects require isolated fixtures and separate authorization.
- Legacy sole-warehouse visibility verification temporarily narrows only the designated company's warehouse links inside its test transaction, then rolls back; its normal Mississauga/Burnaby assignments remain unchanged.

### Carrier Tracking Quality
- Resilience revision `carrier-resilience-20260918-v6`: bounded per-carrier HTTP 429/503 cooldowns and Retry-After scheduling; layout-only browser fallback cannot bypass carrier identity conflicts or throttling.
- Bad scans and failed discovery records are isolated. Retry errors use reviewed codes only; record, tenant, warehouse and worker claim ownership remain enforced.
- Polling batches stop after ten minutes, report deferred records, and release surviving claims by exact token and IDs. Progress liveness never clears completed-cycle quality warnings.
- Confirmed delivery and manual closure are rechecked under the tracker lock, preventing stale workers from downgrading completed shipments.
- Resilience review and release evidence: `docs/CARRIER_TRACKING_RESILIENCE_20260918.md`.
- Process liveness is separate from carrier/Shopify data quality. The private worker health response includes quality, warning, last completion, rejected checks, unresolved active failures and Shopify failures.
- Unresolved checks remain visible while awaiting retry; an empty cycle cannot clear them. A failed cycle cannot present the previous successful report as current healthy tracking.
- Fulfillment rediscovery preserves existing next-poll times, failure counts and error evidence; it cannot reset exponential backoff or force already-scheduled checks to run immediately.
- Counts are integration-scoped and contain no recipient, order or tracking identifiers. Completed, manually closed and expired shipments are excluded from unresolved active counts.
- Reviewed carrier mappings and incident fixtures must protect current-scan identity, tied timestamps, non-delivery exceptions and all-package delivery requirements.
- Incident learning and acceptance checklist: `docs/CARRIER_TRACKING_INCIDENT_20260918.md`. Runtime release evidence: `docs/SHOPIFY_DELIVERY_TRACKING_ROLLOUT.md`.

### Android Upgrade Candidate (Build 39)
- Hosted mobile app only: exact configured HTTPS origin, mobile-only deep links, trusted camera-only web permission grants, safe JSON scan/document callback arguments, visible HTTP/TLS failures and renderer recovery without wiping offline work.
- Retired-screen page/error callbacks cannot overwrite current recovery instructions; certificate failures are cancelled even for a retired screen.
- Firebase synthetic verification completed 2026-09-17 on Android 8/API 26 and Android 15/API 35: six smoke checks passed per device, with final screenshots visually reviewed. The testlab package uses a reserved `.invalid` backend and cannot access production. This does not certify authenticated business workflows or physical hardware.
- Additive local-only upgrade; no API contract, inventory, billing, email, customer-role or warehouse-role changes.
- Acceptance and remaining global-impact checks: `docs/ANDROID_APP_UPGRADE_CHECKLIST.md`. Shared-device cache ownership, native bridge frame-origin control, physical scanner/offline acceptance and production signing remain release gates.
- Native scanner prototype and Alien legacy app are separate modules; this upgrade does not certify or replace them. No production transactions are used for automated checks.

- Versioned partner API with stable external IDs and idempotency protection
- Separate customer orders and warehouse shipments for split fulfillment
- Immutable inventory transaction records for integration reconciliation
- GS1/UCC-128 shipment labels and carrier tracking support
- Shopify fulfillment tracking sends normalized carrier names plus explicit carrier tracking URLs, and existing fulfillments are updated only when the tracking match is unambiguous
- EDI readiness is tracked in `docs/WMS365_EDI_READINESS.md`; X12 translation, acknowledgements, exception handling, and partner certification remain required
- Customer and warehouse isolation is governed by `docs/ACCESS_CONTROL_AUDIT_PROCESS.md` and enforced by `npm run audit:access-control` before deployment.

How to use:
- Find the feature area below.
- Check its primary UI location.
- Walk every related touchpoint before shipping.
- Update this file when new features are added.
- Check `C:\WMS365Scanner\docs\WAREHOUSE_SCREEN_FEATURE_MAP.md` before moving a feature visually.

## Desktop Warehouse Features

| Area | Desktop section | Primary file | Feature owner |
| --- | --- | --- | --- |
| Warehouse Dashboard | `home` | `C:\WMS365Scanner\index.html` | Daily inbound/outbound planning and launch pad |
| Warehouse Task Layer | `home` | `C:\WMS365Scanner\index.html`, `C:\WMS365Scanner\server.js` | System-generated work queue for receiving, put-away, picking, packing, and shipping |
| Purchase Orders | `inbounds` | `C:\WMS365Scanner\index.html` | Expected receipts |
| Receiving | `scan` | `C:\WMS365Scanner\index.html` | Physical stock receipt |
| Inventory Lookup | `search` | `C:\WMS365Scanner\index.html` | Live inventory visibility |
| Adjust & Move | `actions` | `C:\WMS365Scanner\index.html` | Stock corrections and transfers |
| Labels | `labels` | `C:\WMS365Scanner\index.html` | Floor labels |
| Sales Orders | `orders` | `C:\WMS365Scanner\index.html` | Active outbound work |
| Quote & Ship | planned `shipping` | `C:\WMS365Scanner\index.html` | Shipment quotes, packages, labels |
| Shipped Orders | `shipped` | `C:\WMS365Scanner\index.html` | Completed shipment history |
| Master Data | `inventory` | `C:\WMS365Scanner\index.html` | Companies, items, BINs, controls |
| Marketplace Connections | `integrations` | `C:\WMS365Scanner\index.html` | Shopify, SFTP, marketplace, carrier sync |
| Reports & Counts | `reports` | `C:\WMS365Scanner\index.html` | Reporting and exports |
| Billing | `billing` | `C:\WMS365Scanner\index.html` | Customer charges |
| Admin & System | `backup` | `C:\WMS365Scanner\index.html` | Super-user controls |

## Home

### Customer Portal Home
- Customer portal section: `home`
- Primary file: `C:\WMS365Scanner\portal.html`
- Related touchpoints:
  - active fulfillment-location selector
  - pickable inventory scoped to the selected warehouse
  - selected-warehouse stocked SKU and quantity totals
  - selected-warehouse open sales-order and inbound counts
  - draft stock warnings, overdue inbound notices, requested appointments, and billing attention
  - recent sales-order, inbound, and delivery activity
  - quick creation for sales orders, purchase orders, and delivery appointments
  - desktop sidebar and mobile bottom navigation
  - selected-warehouse portal search across pickable inventory, sales orders, POs, tracking, and references
  - search results must never include records from another assigned warehouse until that warehouse is selected
  - tenant and warehouse negative tests
  - competitor evidence and acceptance criteria in `docs/WMS365_CUSTOMER_PORTAL_BENCHMARK.md`

### Warehouse Dashboard
- Desktop section: `home`
- Related touchpoints:
  - active company scoping
  - warehouse task queue
  - open purchase order queue
  - open sales order queue
  - released/picked/staged outbound counts
  - open sales orders grouped by company with 0-2, 3-7, and 8+ day aging buckets
  - oldest-open age and released/picked/staged counts per company
  - company aging rows drill into the permission-scoped sales order queue
  - due today and overdue inbound planning
  - dashboard drill-in to sales order and purchase order document pages
  - top/factbox operational alert counts
  - server refresh and 30-second sync timer

### Warehouse Task Layer
- Desktop section: `home`
- Server table: `warehouse_tasks`
- Related touchpoints:
  - sales order release creates pick task
  - sales order picked creates pack task
  - sales order staged creates ship task
  - shipped or archived orders close active order tasks
  - submitted purchase order creates inbound arrival task
  - arrived purchase order creates receiving task
  - received purchase order creates put-away task
  - company scoping through `account_name`
  - warehouse user access through assigned companies / fulfillment locations
  - fulfillment / 3PL location carried onto each task for warehouse planning
  - assigned worker and assigned warehouse surfaced in the dashboard queue
  - SLA aging labels for overdue / due-soon / on-track tasks
  - mobile task queue routes floor users to receiving, put-away, or mobile picking
  - inbound receipt billing capture when purchase orders are marked received
  - outbound billing capture when sales orders are marked shipped
  - dashboard drill-in back to the source document

## Inbound

### Purchase Orders
- Desktop section: `inbounds`
- Customer portal section: `inbounds`
- Feature flag key: `INBOUND_NOTICES`
- User-facing label: `Purchase Orders`
- Related touchpoints:
  - warehouse PO entry
  - customer portal purchase order submission
  - expected receipt queue
  - mark received workflow
  - receipt confirmation email/export
  - SFTP purchase order import
  - company scoping and feature gating
  - item master filtering by active company

### Receiving
- Desktop section: `scan`
- Mobile section: `scan`
- Related touchpoints:
  - active company scoping
  - scan location/SKU/UPC
  - lot and expiration capture
  - batch save
  - item master traceability rules
  - receiving billing events
  - inventory availability update
  - receipt confirmation output

## Inventory

### Inventory Lookup
- Desktop section: `search`
- Mobile section: `search`
- Placement rule: search/results only; no setup, admin, billing, reports, or integration workspaces.
- Related touchpoints:
  - live inventory server state
  - company scope
  - SKU/UPC/location search
  - multi-item search
  - lot and expiration visibility
  - inventory export permissions

### Customer-Facing Inventory Pools
- Customer portal section: `home`, `inventory`, and `order`
- Server configuration: `company_fulfillment_locations.customer_portal_visible` and `portal_inventory_rollup_location_id`
- Related touchpoints:
  - one customer-visible ship-from warehouse can represent pickable stock held in multiple internal warehouses
  - physical inventory, BIN ownership, lot, expiration, and warehouse access remain assigned to the real warehouse
  - unavailable, investigation, damaged, quarantine, hold, receiving, and staging stock remains excluded
  - active sales-order and kitting reservations are deducted once from the pooled total
  - customer APIs do not expose hidden source warehouses or their BIN codes
  - pooled orders create one warehouse shipment at the customer-selected destination warehouse
  - source allocations remain auditable and create an internal transfer/replenishment task before picking
  - companies without a configured pool retain normal selected-warehouse inventory and approved split-shipment behavior
  - rollup targets must belong to the same company and cannot reference the source assignment itself
  - tenant isolation, warehouse isolation, negative pool tests, and post-deployment read-only reconciliation are required

### Inventory Moves
- Desktop section: `moves`
- Mobile section: `moves`
- Related touchpoints:
  - warehouse-worker move permission without inventory-total adjustment permission
  - company and fulfillment-warehouse isolation on every source and destination
  - dedicated move-only workspace with type-to-fill and scan-ready location inputs
  - customer-owned, warehouse-prefixed stock location creation
  - inventory writes persist resolved company and fulfillment-warehouse ownership onto the BIN master and reject conflicting BIN reuse
  - BIN ownership audit after imports and migrations; findings block release until physically verified
  - operating procedure: `docs/WMS365_BIN_OWNERSHIP_SOP.md`
  - storage locations remain pickable; QC hold, damaged, and quarantine locations are non-pickable
  - up to five JPEG, PNG, or WebP evidence images per QC/damage move, each under 4 MB
  - idempotent movement records, immutable inventory ledger entries, and attachment audit history
  - inventory row safety
  - lot/expiration ambiguity rules
  - stock transfer
  - put-away from receiving/staging into storage BINs
  - BIN move
  - company and warehouse permissions

### Inventory Adjustments
- Desktop section: `actions`
- Mobile section: `actions`
- Warehouse admin only.
- Related touchpoints:
  - quantity adjustment and removal
  - line deletion
  - item conversion
  - inventory count review and posting

### Labels
- Desktop section: `labels`
- Mobile section: `labels`
- Related touchpoints:
  - location records
  - pallet records
  - location label print layout
  - pallet label print layout
  - reprint workflow
  - WMS365 Print Agent for direct printing from WMS365 to printers installed on a warehouse Windows PC
  - one print station is bound to one fulfillment location and cannot claim another warehouse's jobs
  - outbound-only HTTPS connection; warehouse printers and inbound network ports are not exposed
  - station token encrypted for the signed-in Windows user and hidden after setup
  - exact printer-name routing by document role for pick tickets, packing slips, shipping labels, pallet labels, and general documents
  - local printer discovery and test-page workflow
  - durable local print receipts prevent duplicate output when completion confirmation is interrupted
  - stale claimed jobs are automatically recovered only for receipt-capable agents
  - WMS365 job events and document print counts provide an auditable history

### Kitting / Display Builds
- Customer portal sections: `kitting`, `kittingRequests`
- Warehouse desktop section: `actions`
- Standard service commitment: minimum 4 business days from submission.
- Related touchpoints:
  - customer-selected kitting warehouse is stored on the request
  - earliest standard completion is calculated from that warehouse's weekend and holiday calendar
  - needed-by dates earlier than the standard commitment are blocked and directed to sales for expedited review
  - earliest and requested completion dates remain visible in portal history, warehouse review, and notification emails
  - component inventory is reserved only from the selected warehouse
  - finished inventory must be posted to a pickable location in the same warehouse
  - legacy requests without a recorded warehouse remain readable for backward compatibility
  - warehouse notifications are scoped to the selected warehouse and use BCC recipient privacy

## Outbound

### Sales Orders
- Desktop section: `orders`
- Customer portal section: `orders`
- Feature flag key: `ORDER_ENTRY`
- Standard non-parcel processing commitment: minimum 4 business days for every customer, using the selected warehouse's weekend and holiday calendar.
- Related touchpoints:
  - warehouse sales order entry
  - customer sales order draft/release
  - guided customer order entry: Order Setup, Items, Ship To, and Documents
  - account-scoped saved ship-to address selection
  - privacy-preserving live suggestions for new manual ship-to addresses
  - server-validated and standardized ship-to addresses before customer release
  - signed address verification bound to the exact company and physical destination
  - provider-neutral address checking with Geoapify free-tier and Google adapters
  - controlled manual address confirmation when a legitimate destination is unavailable or unresolved
  - manual override reason, confirmer, timestamp, and exact-address audit fields
  - obvious placeholder and malformed postal-code rejection before provider validation
  - mobile Save/Release actions remain non-sticky until an order line exists
  - searchable repeat item entry with duplicate-SKU prevention
  - release email prompt and CC list
  - release PDF copy
  - warehouse notification email
  - warehouse-only routing readiness reminder two business days before freight or customer-pickup delivery
  - warehouse-calendar-aware reminder dates with customer-portal recipients excluded
  - duplicate-protected reminders per order, ship-from warehouse, and delivery date
  - physical PICKED and STAGED confirmation remains required before the one-time routing request can be sent
  - stock allocation and FEFO picking
  - temporary oversell approvals are explicitly scoped by customer, SKU, and warehouse, with a fixed quantity cap and automatic expiry
  - temporary oversell allocates physical stock first, preserves an auditable exception allocation, and never permits shipment inventory to fall below zero
  - customer warnings become non-blocking only within the active approval cap; released orders and pick tickets retain a warehouse-facing physical-stock warning
  - pick ticket
  - pick-ticket PDF and browser print show the item catalog UPC per line, or "Not recorded" when missing; live on Railway since 2026-09-23
  - packing slip
  - staged-only bill of lading generation for LTL, FTL, truck, and customer-pickup shipments
  - required BOL readiness capture for carrier, pallets, shipment weight/unit, and delivery date
  - separate warehouse-shipment BOL pages and freight details for split-location orders
  - customer and warehouse access checks on BOL preparation and PDF retrieval
  - BOL print-event audit history; generated unsigned BOLs do not satisfy signed shipment-proof requirements
  - released/picked/staged/shipped status transitions
  - shipped parcel orders queue a warehouse- and customer-scoped background package-count verification
  - carrier package identifiers are deduplicated; Canpar lead tracking is expanded through the carrier tracking response when available
  - temporary carrier failures retry without blocking shipment completion; unresolved counts enter warehouse-only billing review
  - parcel box supply billing is created only from a verified package count with a shipment-scoped idempotency key
  - visual processing feedback on buttons
  - outbound billing event capture
  - Shopify/SFTP order imports

### Ship-To Address Validation
- Customer portal section: `order`
- Feature flag key: `ORDER_ENTRY`
- Provider configuration: `ADDRESS_VALIDATION_PROVIDER` with `GEOAPIFY_API_KEY` or `GOOGLE_ADDRESS_VALIDATION_API_KEY`
- Related touchpoints:
  - saved destinations remain immediately reusable within the same customer account
  - new manual destinations can be entered, suggested as the user types, corrected, and explicitly accepted
  - release is blocked unless the destination is saved, verified, or explicitly confirmed manually; draft saving remains available
  - verification tokens expire and cannot be reused by another customer or for an edited address
  - warehouse-created and integration-created orders retain their existing internal workflow
  - typed address queries are sent in authenticated request bodies rather than query-string URLs
  - provider outages fail closed and never display an unverified address as verified
  - manual override still blocks missing fields, malformed Canadian/US postal codes, and obvious placeholder data

### Quote & Ship
- Planned desktop section: `shipping`
- Internal spec: `C:\WMS365Scanner\docs\QUOTE_AND_SHIP_FLOW.md`
- Related touchpoints:
  - picked sales orders
  - pack / ship workflow
  - item master dimensions and weight
  - package templates
  - ship-from warehouse locations
  - ship-to sales order address
  - address validation
  - package, pallet, courier pak, and envelope shipment types
  - ready time and close time
  - signature and adult-signature services
  - return label option
  - dangerous goods and special handling flags
  - declared value and insurance
  - ClickShip quote/rate API
  - UPS, FedEx, Canada Post direct carrier APIs
  - label PDF/ZPL storage
  - tracking number storage
  - shipping cost billing capture
  - package material billing capture

### Shipped Orders
- Desktop section: `shipped`
- Customer portal section: `orders` shipment history
- Related touchpoints:
  - shipment confirmation
  - carrier and tracking data
  - POD and attachments
  - customer shipment email
  - shipped confirmation SFTP export
  - billing readiness
  - order archive separation from active queue

### Shipment Billing Readiness Audit
- Desktop section: `backup` (Admin & System, super users only)
- Server table: `shipment_data_quality_findings`
- Schedule: nightly at 3:00 AM Eastern with weekly reminders for unresolved findings
- Related touchpoints:
  - parcel carrier tracking and shipment-type consistency
  - freight BOL and pallet-count completeness
  - shipped quantity confirmation
  - confirmed ship dates and billing service dates
  - duplicate tracking review
  - persistent open/resolved/ignored review history
  - warehouse-scoped corrective notices sent privately by BCC
  - exact fulfillment-location recipient isolation; customer contacts are excluded
  - manual audit runs do not email warehouses
  - no automatic mutation of shipment quantities, dates, documents, or billing events

## Setup

### Master Data
- Desktop section: `inventory`
- Placement rule: setup records only; do not make this an all-purpose workflow launcher.
- Related touchpoints:
  - super user company setup fast path
  - company profile
  - customer cards
  - vendor cards
  - fulfillment locations / 3PL partner sites
  - company-to-fulfillment-location assignment
  - BIN locations
  - item master
  - distinct inventory tracking UOM, unit UOM, and quantity-per-case packaging fields
  - item CSV import/export preservation of unit UOM metadata
  - store SKU mapping
  - lot required flag
  - expiration required flag
  - FEFO picking eligibility
  - customer portal login access
  - portal welcome/access email when a new password is issued
  - company feature access handoff
  - bulk inventory worksheet
  - company-scoped item lists

### Marketplace Connections
- Desktop section: `integrations`
- Related server file: `C:\WMS365Scanner\server.js`
- Feature flag keys:
  - `STORE_INTEGRATIONS`
  - `SHOPIFY_INTEGRATION`
  - `SFTP_INTEGRATION`
- Related touchpoints:
  - Shopify store URL
  - Shopify Admin API access token
  - Shopify client credentials
  - public Shopify app install from WMS365 with HMAC-verified callback and signed company/store-bound OAuth state
  - OAuth install upserts only the selected company's matching Shopify integration and preserves other tenants
  - Shopify app configuration uses the registered `/shopify/callback` redirect and least-privilege Admin API scopes
  - SFTP host/port/user/folders
  - marketplace provider catalog
  - Best Buy marketplace connector staging
  - carrier connection setup for ClickShip/direct carriers
  - pull orders schedule
  - pull purchase orders schedule
  - push shipped confirmations
  - push receipt confirmations
  - push inventory snapshots
  - shared-pool Shopify variant mappings with a whole-number WMS-unit multiplier per store item
  - imported store quantities expand into the mapped WMS base unit
  - Shopify availability is derived as `floor(pickable WMS units / variant multiplier)` so every mapped pack size draws from one stock pool
  - manual sync
  - integration run logs
  - company scoping

## Reporting

### Reports & Counts
- Desktop section: `reports`
- Related touchpoints:
  - inventory export
  - location report
  - item report
  - vendor inventory report
  - utilization
  - count review
  - company scope and filters
  - CSV/PDF output
  - token-authenticated, read-only Healtea month-end activity API with strict tenant scope, calendar-month validation, Toronto warehouse dates, and downloadable JSON detail

## Commercial

### Billing
- Desktop section: `billing`
- Related server file: `C:\WMS365Scanner\server.js`
- Internal spec: `C:\WMS365Scanner\docs\ZOHO_BOOKS_BILLING_SCOPE.md`
- Related touchpoints:
  - Zoho Books customer/contact mapping
  - Zoho Books service/item mapping
  - invoice batches
  - billing cadence by company
  - progress billing by warehouse / 3PL location
  - assigned-account billing rollups
  - company fee setup
  - receiving charges
  - picking charges
  - labeling charges
  - supplies used
  - storage billing
  - company billing automation policies with effective dates and per-activity controls
  - transaction-date billing for shipped orders and received purchase orders
  - initial inbound storage billing by actual standard, oversize, or non-standard pallet count
  - BCC-only billing notifications with system summaries and all stored transaction backup
  - delivery-ledger idempotency and scheduled reconciliation for missed completion notifications
  - company-specific rates remain mandatory; missing rates produce a billing-setup alert instead of an invented charge
  - shipping cost capture
  - package material charges
  - address validation charges
  - return label charges
  - dangerous goods/special handling charges
  - manual billing lines
  - billing ledger
  - month-end export
  - shipped-order billing completeness
  - Zoho sync status and retry log

## System

### Admin & System
- Desktop section: `backup`
- Related touchpoints:
  - company email flow check
  - latest order email routing test
  - system email test
  - email queue / delivery log
  - company feature access
  - warehouse users
  - warehouse roles: worker, customer service, warehouse admin, super user
  - warehouse / 3PL location access
  - inherited customer company access through warehouse assignment
  - feedback/bug queue
  - daily admin summary email
  - import/export
  - backup/restore
  - deployment/build visibility
  - version endpoint

## Customer Portal Features

Primary file:
- `C:\WMS365Scanner\portal.html`

Portal features:
- customer login
- compact signed-in application header
- persistent desktop sidebar with permission-scoped destinations
- mobile bottom navigation with an overflow menu
- Home-only activity overview and quick actions
- URL-backed portal views with browser Back/Forward support
- automatic scroll and heading focus after navigation
- inventory view
- inventory export
- item master view
- new sales order
- sales order draft/release
- release email/PDF options
- new purchase order
- purchase order history
- shipped order visibility
- feedback/bug reporting
- deployment/build label

Portal safety checks:
- customer can only see its own inventory
- customer can only export its own inventory
- customer can only submit orders for its own company
- customer company is derived from login/session, not a visible selector
- ship-to address suggestions are company scoped
- navigation destinations inherit existing company permissions and feature flags
- changing portal screens preserves unsaved form fields
- desktop and mobile visual tests verify that selected work is immediately visible

## Mobile Worker Features

Primary file:
- `C:\WMS365Scanner\index.html`

Mobile features:
- mobile home
- receive stock
- inventory lookup
- adjust/move
- pallet labels
- picking support
- mobile-only in-app back button
- no desktop setup/integrations menu
- force mobile experience on phones even when rotated

## Public Website / Signup Features

Primary folder:
- `C:\WMS365Scanner\bluehost-site`
- `C:\WMS365Scanner\marketing`

Related server file:
- `C:\WMS365Scanner\server.js`

Public features:
- WMS365 Access Center gateway before warehouse/customer login
- marketing home
- platform page
- integrations page
- industries pages
- pricing page
- affiliate program page and sendable affiliate sales pack
- hiring / sales-member page and recruiting package
- book demo form
- SEO landing pages
- sitemap and robots files
- Stripe checkout/signup
- 14-day card-backed Stripe trial for Launch Warehouse
- company pricing/paywall controls
- Grey Wolf 3PL no-charge portal access for assigned companies
- public API CORS allowlist
- domain routing for `wms365.co` and `app.wms365.co`
- app subdomain root routes to `/access` for unauthenticated users

## Cross-Cutting Checks

Always check these when changing related workflows:
- company scoping and permissions
- warehouse user assigned-warehouse access
- inherited company access from fulfillment location assignment
- company feature flags
- lot tracking
- expiration tracking
- FEFO allocation/picking
- button loading and success/error feedback
- notifications and emails
- attachments and PDFs
- reports and exports
- billing events
- mobile behavior
- customer portal behavior
- customer portal inventory, dashboard quantity, bin list, order availability, and exports follow the active assigned warehouse
- sole-warehouse legacy bins remain visible only to that assigned warehouse and are verified against a real database transaction
- invalid or unassigned customer warehouse inventory requests fail closed
- build/version visibility

Release verification:
- `npm run check:release` is the complete local release gate, including Node tests, access-control audit, customer-portal browser journeys, billing UI browser audit, and guide screenshot validation.
- `railway run npm run check:database` verifies production schema controls and rollback-only test-company workflows before a high-risk release.
- `railway run npm run check:fresh-database` boots WMS365 against an isolated temporary schema, waits for full readiness, verifies core platform tables, and removes the schema.

## Windows Print Connector 1.2

Primary files: `print-agent/`, `server.js`, `warehouse-print-queue.spec.js`.

- Windows x64 installer with bundled supported Node.js runtime. The independent PDF engine downloads directly from its publisher with checksum verification.
- Normal warehouse username/password sign-in; temporary session discarded after enrollment. No saved password; Windows DPAPI protects the station credential.
- Stations bind user, installation, and warehouse. Claims recheck active user/role, warehouse assignment, and accessible customer accounts.
- Letter/label defaults plus eight document-specific printer mappings; synchronizes installed devices without changing shared warehouse defaults.
- Durable receipts precede submission. Ambiguous interruptions require manual review; acknowledgment outages do not print another copy.
- Loopback control page validates Host, Origin, and a random control secret.
- Direct BOL queue uses the actual BOL builder and retains staged-order prerequisites.

Release gates: connector/security tests, shared platform suite, installer smoke test, desktop/mobile visual checks, isolated test-company verification, and physical letter/thermal printer acceptance. Simulated tests do not certify physical printing. Deploy the backend enrollment endpoints before distributing for live use.

## Print Connector Device Security (1.4.0)

- Standard JOSE ES256/P-256 device proofs using pinned jose 6.2.12; separate from the OTA publisher key.
- Windows DPAPI protects device keys and local-screen access; unauthenticated loopback pages disclose no control secrets or warehouse details.
- Registration binds active warehouse user, customer/warehouse scope, installation UUID, public-key thumbprint and 30-day expiring credential.
- DPoP method/URI/token checks plus exact-body SHA256, installation binding, a 60-second time window, and PostgreSQL one-use proof IDs across server instances.
- Inactive warehouses, revoked users, mismatched keys, altered bodies, copied tokens, replayed signatures and unsigned registration fail closed and use access-restriction auditing.
- Header-only credentials, 64 KB request bounds, exact official HTTPS origin, local HttpOnly/SameSite cookie plus control secret, and no automatic insecure fallback.
- Revoked local agents stop repeating cloud requests until reauthorization. Startup cannot claim jobs until this process owns the local listening port.
- Migration is additive to printing schema only. No customer inventory/order/email/billing records change. Legacy stations require coordinated re-enrollment; legacy compatibility is disabled by default.
- Release gates: protocol/Windows-storage tests, tenant/warehouse negative tests, shared suite, real-signature browser tests, signed package and installer checks, backend deployment, database-schema verification and physical printer pilot. DPAPI is not TPM storage; software/package Authenticode signing and edge abuse controls remain rollout requirements.

## Print Connector OTA Updates (1.3.0)

- Platform-wide Windows workstation updater; no customer or inventory transactions are created.
- Hourly signed-release checks, explicit Check for Updates, and 30-second idle retries while waiting for printing.
- Pinned Ed25519 publisher key, HTTPS host/path allowlist, no redirects, expiring announcements, bounded downloads, exact SHA256 and version checks; no downgrades.
- New print claims and local mutations pause during verified installation; active prints finish first.
- Preserves Windows-encrypted credentials, printer choices, receipt history, PDF engine and shortcuts.
- Detached replacement helper keeps rollback copy, validates restarted process/version, restores failed starts and prevents repeated failing-release installs.
- Dedicated public artifact route serves only stable.json and versioned Windows ZIPs from PRINT_CONNECTOR_RELEASE_DIR; private signing keys and business documents must never be stored there.
- Release gates: update security tests, Windows success/rollback smoke tests, browser checks, signed-package verification, backend deployment, owner key recovery plan and physical printer pilot. Earlier 1.2.0 installations require one manual upgrade. Signing is not Windows Authenticode certification.

## Carrier Tracking Hub

Primary files:
- `carrier-tracking.js`
- `server.js`
- `portal.html`
- `docs/wms365-partner-api-v1.yaml`

Platform behavior:
- creates one customer- and warehouse-owned tracker for each warehouse shipment tracking number
- normalizes carrier checkpoints into a shared WMS365 status vocabulary
- stores tracking checkpoints as immutable, deduplicated events
- supports signed provider webhooks plus retry-safe background polling
- stops polling terminal delivered, returned, or cancelled shipments
- exposes selected-warehouse delivery timelines in the customer portal
- exposes shipment tracking through the customer-scoped partner API
- keeps provider credentials server-side and remains safely inactive when credentials are absent
- quarantines ambiguous webhook matches instead of guessing across customers

Carrier tracking release checks:
- verify customer, warehouse, partner API, and guessed-ID isolation
- verify duplicate webhook delivery creates no duplicate event
- verify failed polling backs off and a successful response resets the failure count
- verify terminal shipments are no longer polled
- verify compact provider statuses such as `InTransit` and `InfoReceived`
- verify the customer portal follows the active warehouse selector
- use only the designated test company for end-to-end transaction tests

## Shopify Carrier Delivery Events and Notifications

Local platform/UI candidate added 2026-09-17. A separate restricted tracking worker
was deployed for Shopify integration 4 only. ORD-000694 has a genuine GLS scan and
verified Shopify DELIVERED read-back. Full rollout and notification inbox
acceptance remain incomplete; see the rollout report for exact gates.

Primary files:
- `shopify-tracking-sync.js`
- `shopify-delivery-notifications.js`
- `shopify-delivery-notification-service.js`
- `carrier-tracking-browser.js`
- `carrier-public-tracking.js`
- `carrier-public-http.js`
- `shopify-tracking-worker.js`
- `shopify-tracking-api.js`
- `docs/SHOPIFY_DELIVERY_TRACKING_ROLLOUT.md`

Global safeguards:
- per-store opt-in, notification sending disabled by default
- durable fulfillment/package ownership and status/time event deduplication
- remote event reconciliation before uncertain Shopify send retries
- every expected package must have real carrier-delivery evidence
- separate notification history, consent checks and conservative unknown outcomes
- native Shopify setting reviews are scoped and audited, not inferred from API success
- browser fallback rejects unverified layouts and confines private diagnostics
- GLS Canada uses AfterShip `dicom` separately from Shopify's recognized `GLS`
- no changes to physical inventory, allocation, billing or order-release rules

Release gates remain: dedicated Shopify development store/test recipient,
tracking-provider access, native notification setting review, actual order-status
page and inbox verification, PostgreSQL integration checks, shared regression
tests and post-deployment verification. Local fixtures are not proof of real
carrier access, customer email receipt or a production release.

## Durable Sales Order Shipment Evidence

Platform behavior:
- Selecting a signed BOL/POD, checked packing slip, or load photo saves it to the sales order immediately; saving evidence is independent of the final shipment transaction.
- The order refreshes with persisted evidence status, so a reload or another authorized user can continue the closeout without re-uploading files.
- Mark Shipped waits for pending uploads and validates the persisted evidence categories before inventory, billing, email, integration, or order-status effects run.
- A failed shipment validation or transaction leaves already-saved evidence attached to the unshipped order for recovery and audit.
- Document upload authorization enforces both exact company ownership and the user's allowed fulfillment warehouse scope.
- Existing API clients that submit shipment evidence with the final closeout remain supported; server validation considers both persisted and request-supplied documents.

Release checks:
- use only the designated test company for transaction testing; never create shipment evidence or shipping transactions in a live customer company for a test
- verify an uploaded file survives reload and a deliberately failed Mark Shipped attempt
- verify a second authorized user can see the saved evidence and finish the order
- verify users from another company or warehouse cannot upload, list, download, or use the evidence
- verify parcel closeout, freight overrides, short shipment handling, inventory, billing, emails, documents, integrations, mobile capture, and audit history remain unchanged except for the earlier durable save
