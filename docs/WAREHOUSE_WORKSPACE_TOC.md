# WMS365 Warehouse Workspace TOC

Last reviewed: 2026-04-26

Purpose:
- This is the human-maintained table of contents for the warehouse desktop app.
- Keep this file aligned with the runtime map in `C:\WMS365Scanner\index.html`.
- Update this file whenever a section is added, renamed, split, moved, hidden, or exposed to the customer portal/mobile app.

Runtime source of truth:
- `C:\WMS365Scanner\index.html`
- `const WAREHOUSE_WORKSPACE_TOC = Object.freeze(...)`

Navigation principles:
- Keep the left nav workflow-based, not feature-dump based.
- Use a WMS365-branded Dynamics-style desktop method: top module menus, command bar, list/workspace page, then drill into the working form and back out.
- Do not use Microsoft, Dynamics, or Business Central branding in the product UI; keep the experience familiar but clearly WMS365.
- Treat the desktop left navigation as a hidden backing structure; users should primarily enter workflows from the top module menus and command bar.
- Put document entry before execution when users naturally start with paperwork.
- Keep Sales Orders and Purchase Orders as first-class sections.
- Keep shipped orders separate from the live sales order work queue.
- Keep mobile focused on floor tasks only.
- Keep public website, signup, SEO, and Stripe outside the warehouse desktop navigation.

## Desktop Navigation Order

| Group | Section order | Reason |
| --- | --- | --- |
| Home | Operations Home | Launch pad and quick actions |
| Inbound | Purchase Orders, Receiving | Enter expected receipts first, then physically receive |
| Inventory | Inventory Lookup, Adjust & Move, Labels | Find stock, correct/move stock, print floor labels |
| Outbound | Sales Orders, Shipped Orders | Process active orders separately from completed shipments |
| Setup | Master Data, Integrations | Configure companies/items/locations before connections |
| Reporting | Reports & Counts | Review/export warehouse data |
| Commercial | Billing | Capture and review customer charges |
| System | Admin & System | Super-user controls, users, feedback, backups, versioning |

## Group: Home

### Section: `home`
- Title: `Operations Home`
- Drill path: `Home / Operations`
- Purpose: compact launch directory for the main warehouse workflows
- Primary features:
  - New Sales Order
  - New Purchase Order
  - Receive Stock
  - Inventory Lookup

## Group: Inbound

### Section: `inbounds`
- Title: `Purchase Orders`
- Drill path: `Inbound / Purchase Orders`
- Purpose: create and manage expected receipts before freight arrives
- Primary features:
  - New Purchase Order
  - PO Lines
  - Purchase Order Queue
  - Mark Received
- Related channels:
  - customer portal purchase orders
  - SFTP purchase order import
  - receipt confirmation export/email

### Section: `scan`
- Title: `Receiving`
- Drill path: `Inbound / Receiving`
- Purpose: physical receiving flow for scanning, staging, and saving stock
- Primary features:
  - Scan Receiving
  - Current Batch
  - Lot / Expiration Capture
  - Save Batch
- Related channels:
  - mobile receive flow
  - receiving billing events
  - lot/expiration inventory creation

## Group: Inventory

### Section: `search`
- Title: `Inventory Lookup`
- Drill path: `Inventory / Lookup`
- Purpose: live company-scoped inventory lookup
- Primary features:
  - SKU / UPC Search
  - Location Search
  - Multi Item Search
  - Lot / Expiration Review

### Section: `actions`
- Title: `Adjust & Move`
- Drill path: `Inventory / Adjust & Move`
- Purpose: controlled stock corrections and internal movements
- Primary features:
  - Remove Quantity
  - Delete Line
  - Transfer Stock
  - Convert Items
  - Move BIN

### Section: `labels`
- Title: `Labels`
- Drill path: `Inventory / Labels`
- Purpose: print and reprint warehouse floor labels
- Primary features:
  - Location Labels
  - Pallet Labels
  - Pallet Reprint

## Group: Outbound

### Section: `orders`
- Title: `Sales Orders`
- Drill path: `Outbound / Sales Orders`
- Purpose: create and process active customer sales orders
- Primary features:
  - New Sales Order
  - Sales Order Queue
  - Pick Tickets
  - Packing Slips
  - Pick / Stage / Ship
- Related channels:
  - customer portal sales order release
  - warehouse release notification email
  - Shopify/SFTP imported orders
  - outbound billing events

### Section: `shipped`
- Title: `Shipped Orders`
- Drill path: `Outbound / Shipped Orders`
- Purpose: completed shipment history and customer confirmation records
- Primary features:
  - Shipped Queue
  - Carrier / Tracking
  - Shipment Documents
  - Customer Email Confirmation
  - SFTP Shipment Export

## Group: Setup

### Section: `inventory`
- Title: `Master Data`
- Drill path: `Setup / Master Data`
- Purpose: maintain the records that power all warehouse work
- Primary features:
  - Company Profile
  - BIN Locations
  - Item Master
  - Lot / Expiration Controls
  - Portal Access
  - Bulk Inventory Worksheet

### Section: `integrations`
- Title: `Integrations`
- Drill path: `Setup / Integrations`
- Purpose: connect customer order, purchase order, shipment, receipt, and inventory data lanes
- Primary features:
  - Shopify
  - SFTP
  - Sync Schedules
  - Pull Orders
  - Pull Purchase Orders
  - Push Confirmations

## Group: Reporting

### Section: `reports`
- Title: `Reports & Counts`
- Drill path: `Reporting / Reports & Counts`
- Purpose: review, count, and export warehouse data
- Primary features:
  - Inventory Export
  - Location Report
  - Item Report
  - Vendor Inventory
  - Utilization / Counts

## Group: Commercial

### Section: `billing`
- Title: `Billing`
- Drill path: `Commercial / Billing`
- Purpose: capture and prepare customer charges for month-end billing
- Primary features:
  - Company Fee Setup
  - Manual Billing Events
  - Storage Billing
  - Billing Ledger
  - Invoice Exports

## Group: System

### Section: `backup`
- Title: `Admin & System`
- Drill path: `System / Admin & System`
- Purpose: super-user tools, safeguards, and support visibility
- Primary features:
  - Import / Export
  - Company Feature Access
  - Warehouse Users
  - Feedback Queue
  - Daily Admin Summary
  - Build / Version

## Logged Outside Desktop Navigation

These features are part of the product but should not clutter the warehouse desktop left nav:
- Customer Portal: login, inventory, item master, new sales order, new purchase order, order history, purchase order history, export, feedback.
- Mobile Worker: receive stock, lookup inventory, adjust/move, pallet labels, picking, mobile-only back behavior.
- Public Website: marketing pages, SEO landing pages, demo request, Stripe signup, pricing, domain routing.
- Platform Services: email SMTP, scheduled sync, daily admin summary, Stripe webhook handling, app version endpoint.

## TOC Update Rules

Whenever a warehouse workflow changes:
- Update the runtime TOC in `index.html`.
- Update this file.
- Update `WAREHOUSE_FEATURE_REGISTRY.md` if a feature moved or gained dependencies.
- Check the home directory grouping.
- Check the left navigation grouping.
- Check the workspace drill path.
- Check section titles and helper text.
- Check customer portal exposure if the feature is customer-facing.
- Check mobile exposure if the feature is floor-facing.
