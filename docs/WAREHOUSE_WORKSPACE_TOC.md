# WMS365 Warehouse Workspace TOC

Purpose:
- Internal table of contents for the warehouse desktop.
- Keep navigation, home directory, drill path, and major feature grouping aligned.
- Update this file whenever a warehouse section is added, renamed, split, or moved.

Runtime source of truth:
- The live desktop app currently reads its workspace TOC from:
  - `C:\WMS365Scanner\index.html`
  - `const WAREHOUSE_WORKSPACE_TOC = Object.freeze(...)`
- This Markdown file is the human-maintained planning/reference copy.

## Group: Home

### Section: `home`
- Title: `Operations Home`
- Drill path: `Home / Operations`
- Purpose: landing directory for warehouse workflows
- Primary features:
  - Receiving
  - Purchase Orders
  - Inventory Lookup
  - Order Execution

## Group: Inbound

### Section: `scan`
- Title: `Receiving`
- Drill path: `Inbound / Receiving`
- Purpose: warehouse scan-and-stage workflow
- Primary features:
  - Scan & Stage
  - Current Batch
  - Traceability
  - Batch Save

### Section: `inbounds`
- Title: `Purchase Orders`
- Drill path: `Inbound / Purchase Orders`
- Purpose: expected receipt and inbound notice entry
- Primary features:
  - PO Entry
  - Inbound Lines
  - Inbound Queue

## Group: Inventory Control

### Section: `search`
- Title: `Inventory`
- Drill path: `Inventory Control / Lookup`
- Purpose: live inventory lookup and search
- Primary features:
  - Single Search
  - Multi Search
  - Search Results

### Section: `actions`
- Title: `Adjust & Move`
- Drill path: `Inventory Control / Adjust & Move`
- Purpose: stock corrections and location changes
- Primary features:
  - Delete
  - Transfer
  - Convert
  - Move BIN

### Section: `labels`
- Title: `Labels`
- Drill path: `Inventory Control / Labels`
- Purpose: floor-facing location and pallet labels
- Primary features:
  - Location Labels
  - Pallet Labels
  - Reprint

## Group: Outbound

### Section: `orders`
- Title: `Sales Orders`
- Drill path: `Outbound / Sales Orders`
- Purpose: live outbound work queue
- Primary features:
  - Order Queue
  - Pick Tickets
  - Packing Slips
  - Pick / Stage / Ship

### Section: `shipped`
- Title: `Shipped Orders`
- Drill path: `Outbound / Shipped Orders`
- Purpose: completed shipment history and documentation
- Primary features:
  - Shipment History
  - Tracking
  - Documents

## Group: Reporting

### Section: `reports`
- Title: `Reports & Counts`
- Drill path: `Reporting / Reports & Counts`
- Purpose: warehouse reporting and exports
- Primary features:
  - Desktop Reports
  - Utilization
  - Location Report
  - Item Report
  - Inventory Export

## Group: Setup & Commercial

### Section: `inventory`
- Title: `Master Data`
- Drill path: `Setup & Commercial / Master Data`
- Purpose: administrative warehouse master records
- Primary features:
  - Company Profile
  - BINs
  - Item Master
  - Portal Access
  - Inventory Worksheet

### Section: `integrations`
- Title: `Integrations`
- Drill path: `Setup & Commercial / Integrations`
- Purpose: store and file-based order lanes
- Primary features:
  - Shopify
  - SFTP
  - Schedules
  - Manual Sync

### Section: `billing`
- Title: `Billing`
- Drill path: `Setup & Commercial / Billing`
- Purpose: warehouse fee setup and billing capture
- Primary features:
  - Company Fees
  - Manual Billing
  - Billing Ledger

## Group: System

### Section: `backup`
- Title: `Admin & System`
- Drill path: `System / Admin & System`
- Purpose: administrative controls and safeguards
- Primary features:
  - Import / Export
  - Company Features
  - Warehouse Users
  - Feedback Queue

## TOC Update Rules

Whenever a warehouse workflow changes:
- Update the runtime TOC in `index.html`
- Update this file
- Check the home directory grouping
- Check the left navigation grouping
- Check the workspace drill path
- Check section titles and helper text
- Check mobile exposure if the feature is mobile-facing
