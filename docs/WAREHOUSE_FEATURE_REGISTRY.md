# WMS365 Warehouse Feature Registry

Last reviewed: 2026-04-30

Purpose:
- Internal feature inventory so changes do not break related workflow pieces.
- Use this before moving, renaming, hiding, or expanding warehouse features.
- This file catches hidden dependencies outside the visible screen.

How to use:
- Find the feature area below.
- Check its primary UI location.
- Walk every related touchpoint before shipping.
- Update this file when new features are added.

## Desktop Warehouse Features

| Area | Desktop section | Primary file | Feature owner |
| --- | --- | --- | --- |
| Warehouse Dashboard | `home` | `C:\WMS365Scanner\index.html` | Daily inbound/outbound planning and launch pad |
| Purchase Orders | `inbounds` | `C:\WMS365Scanner\index.html` | Expected receipts |
| Receiving | `scan` | `C:\WMS365Scanner\index.html` | Physical stock receipt |
| Inventory Lookup | `search` | `C:\WMS365Scanner\index.html` | Live inventory visibility |
| Adjust & Move | `actions` | `C:\WMS365Scanner\index.html` | Stock corrections and transfers |
| Labels | `labels` | `C:\WMS365Scanner\index.html` | Floor labels |
| Sales Orders | `orders` | `C:\WMS365Scanner\index.html` | Active outbound work |
| Quote & Ship | planned `shipping` | `C:\WMS365Scanner\index.html` | Shipment quotes, packages, labels |
| Shipped Orders | `shipped` | `C:\WMS365Scanner\index.html` | Completed shipment history |
| Master Data | `inventory` | `C:\WMS365Scanner\index.html` | Companies, items, BINs, controls |
| Integrations | `integrations` | `C:\WMS365Scanner\index.html` | Shopify, SFTP, sync |
| Reports & Counts | `reports` | `C:\WMS365Scanner\index.html` | Reporting and exports |
| Billing | `billing` | `C:\WMS365Scanner\index.html` | Customer charges |
| Admin & System | `backup` | `C:\WMS365Scanner\index.html` | Super-user controls |

## Home

### Warehouse Dashboard
- Desktop section: `home`
- Related touchpoints:
  - active company scoping
  - open purchase order queue
  - open sales order queue
  - released/picked/staged outbound counts
  - due today and overdue inbound planning
  - dashboard drill-in to sales order and purchase order document pages
  - top/factbox operational alert counts
  - server refresh and 30-second sync timer

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
- Related touchpoints:
  - live inventory server state
  - company scope
  - SKU/UPC/location search
  - multi-item search
  - lot and expiration visibility
  - inventory export permissions

### Adjust & Move
- Desktop section: `actions`
- Mobile section: `actions`
- Related touchpoints:
  - inventory row safety
  - lot/expiration ambiguity rules
  - quantity removal
  - line deletion
  - stock transfer
  - item conversion
  - BIN move
  - company permissions

### Labels
- Desktop section: `labels`
- Mobile section: `labels`
- Related touchpoints:
  - location records
  - pallet records
  - location label print layout
  - pallet label print layout
  - reprint workflow

## Outbound

### Sales Orders
- Desktop section: `orders`
- Customer portal section: `orders`
- Feature flag key: `ORDER_ENTRY`
- Related touchpoints:
  - warehouse sales order entry
  - customer sales order draft/release
  - release email prompt and CC list
  - release PDF copy
  - warehouse notification email
  - stock allocation and FEFO picking
  - pick ticket
  - packing slip
  - released/picked/staged/shipped status transitions
  - visual processing feedback on buttons
  - outbound billing event capture
  - Shopify/SFTP order imports

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

## Setup

### Master Data
- Desktop section: `inventory`
- Related touchpoints:
  - super user company setup fast path
  - company profile
  - fulfillment locations / 3PL partner sites
  - company-to-fulfillment-location assignment
  - BIN locations
  - item master
  - lot required flag
  - expiration required flag
  - FEFO picking eligibility
  - customer portal login access
  - company feature access handoff
  - bulk inventory worksheet
  - company-scoped item lists

### Integrations
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
- Related touchpoints:
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

## System

### Admin & System
- Desktop section: `backup`
- Related touchpoints:
  - import/export
  - backup/restore
  - company feature access
  - warehouse users
  - assigned-company access
  - feedback/bug queue
  - daily admin summary email
  - deployment/build visibility
  - version endpoint

## Customer Portal Features

Primary file:
- `C:\WMS365Scanner\portal.html`

Portal features:
- customer login
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
- `C:\WMS365Scanner\public-site`

Related server file:
- `C:\WMS365Scanner\server.js`

Public features:
- marketing home
- platform page
- integrations page
- industries pages
- pricing page
- book demo form
- SEO landing pages
- sitemap and robots files
- Stripe checkout/signup
- public API CORS allowlist
- domain routing for `wms365.co` and `app.wms365.co`

## Cross-Cutting Checks

Always check these when changing related workflows:
- company scoping and permissions
- warehouse user assigned-company access
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
- build/version visibility
