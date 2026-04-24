# WMS365 Warehouse Feature Registry

Purpose:
- Internal feature inventory so changes do not break related workflow pieces.
- Use this file before moving, renaming, or expanding warehouse features.

How to use:
- If a feature changes, update its row and then walk the related touchpoints.
- This file is intended to catch “hidden” dependencies outside the visible screen.

## Inbound

### Receiving
- Desktop section: `scan`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - active company scoping
  - batch save
  - item master traceability
  - billing events for receiving
  - lot / expiration handling
  - mobile receive flow

### Purchase Orders / Inbounds
- Desktop section: `inbounds`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - inbound queue
  - customer portal inbound notices
  - receiving queue visibility
  - company feature flag for inbound notices
  - receipt confirmation
  - SFTP inbound sync lanes

## Inventory

### Inventory Lookup
- Desktop section: `search`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - live inventory server state
  - company scope
  - lot / expiration visibility
  - search print/export flows

### Adjust & Move
- Desktop section: `actions`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - inventory row safety
  - lot / expiration ambiguity rules
  - pallet movement
  - company permissions

### Labels
- Desktop section: `labels`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - location records
  - pallet records
  - print layouts
  - mobile pallet handling

## Outbound

### Sales Orders
- Desktop section: `orders`
- Main UI files:
  - `C:\WMS365Scanner\index.html`
  - `C:\WMS365Scanner\portal.html`
- Related touchpoints:
  - customer order draft / release
  - stock allocation
  - pick / stage / ship statuses
  - pick ticket / packing slip output
  - release email / PDF options
  - billing capture
  - warehouse notifications
  - shipped customer notifications

### Shipped Orders
- Desktop section: `shipped`
- Main UI files:
  - `C:\WMS365Scanner\index.html`
  - `C:\WMS365Scanner\portal.html`
- Related touchpoints:
  - shipment confirmation
  - tracking
  - POD / attachments
  - customer email confirmation
  - billing readiness

## Reporting

### Reports & Counts
- Desktop section: `reports`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - inventory worksheet
  - CSV export
  - count review
  - utilization
  - company scope and filters

## Setup

### Master Data
- Desktop section: `inventory`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - companies
  - BINs
  - item master
  - customer portal access
  - warehouse users / company assignments
  - feature flags
  - inventory worksheet

### Integrations
- Desktop section: `integrations`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related server file:
  - `C:\WMS365Scanner\server.js`
- Related touchpoints:
  - Shopify
  - SFTP
  - schedule options
  - company scoping
  - imported orders
  - shipment / receipt / inventory exports

## Commercial

### Billing
- Desktop section: `billing`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related server file:
  - `C:\WMS365Scanner\server.js`
- Related touchpoints:
  - rate setup
  - auto-generated billing events
  - manual billing lines
  - month-end export
  - shipped-order billing completeness

## System

### Admin & System
- Desktop section: `backup`
- Main UI file:
  - `C:\WMS365Scanner\index.html`
- Related touchpoints:
  - import / export
  - backup / restore
  - company feature access
  - warehouse users
  - bug / feature queue
  - deployment/build visibility

## Portal / Customer-Facing Features

These are not warehouse nav sections, but warehouse changes often affect them:
- Customer login and portal layout
- Customer inventory view / export
- Customer sales order draft / release
- Customer inbound notices
- Customer feedback / bug reporting
- Customer shipment notifications

Primary file:
- `C:\WMS365Scanner\portal.html`

## Cross-Cutting Features

These should always be checked when changing related workflows:
- company scoping and permissions
- warehouse user assigned-company access
- company feature flags
- lot tracking
- expiration tracking / FEFO
- notifications and emails
- attachments / PDFs
- reports / exports
- billing events
- mobile behavior
- customer portal behavior
- deployment/build label visibility
