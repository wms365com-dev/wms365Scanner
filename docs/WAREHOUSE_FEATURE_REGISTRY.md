# WMS365 Warehouse Feature Registry

Last reviewed: 2026-09-01

Purpose:
- Internal feature inventory so changes do not break related workflow pieces.
- Use this before moving, renaming, hiding, or expanding warehouse features.
- This file catches hidden dependencies outside the visible screen.

## Integration Foundation

- Versioned partner API with stable external IDs and idempotency protection
- Separate customer orders and warehouse shipments for split fulfillment
- Immutable inventory transaction records for integration reconciliation
- GS1/UCC-128 shipment labels and carrier tracking support
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

### Inventory Moves
- Desktop section: `moves`
- Mobile section: `moves`
- Related touchpoints:
  - warehouse-worker move permission without inventory-total adjustment permission
  - company and fulfillment-warehouse isolation on every source and destination
  - dedicated move-only workspace with type-to-fill and scan-ready location inputs
  - customer-owned, warehouse-prefixed stock location creation
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
  - pick ticket
  - packing slip
  - staged-only bill of lading generation for LTL, FTL, truck, and customer-pickup shipments
  - required BOL readiness capture for carrier, pallets, shipment weight/unit, and delivery date
  - separate warehouse-shipment BOL pages and freight details for split-location orders
  - customer and warehouse access checks on BOL preparation and PDF retrieval
  - BOL print-event audit history; generated unsigned BOLs do not satisfy signed shipment-proof requirements
  - released/picked/staged/shipped status transitions
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
  - SFTP host/port/user/folders
  - marketplace provider catalog
  - Best Buy marketplace connector staging
  - carrier connection setup for ClickShip/direct carriers
  - pull orders schedule
  - pull purchase orders schedule
  - push shipped confirmations
  - push receipt confirmations
  - push inventory snapshots
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
