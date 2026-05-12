# Zoho Books Billing Scope

Last reviewed: 2026-05-08

Purpose:
- Define how WMS365 should capture 3PL billable activity, prepare invoice batches, and sync those invoices to Zoho Books.
- Keep billing company-scoped so one customer can never see or affect another customer's billing data.
- Treat Zoho as the accounting system of record for invoices and payments, while WMS365 remains the operational source of billable warehouse work.

Official Zoho references reviewed:
- Zoho Books Invoices API: https://www.zoho.com/books/api/v3/invoices/
- Zoho Books Contacts API: https://www.zoho.com/books/api/v3/contacts/
- Zoho Books Items API: https://www.zoho.com/books/api/v3/items/
- Zoho Books OAuth / API introduction: https://www.zoho.com/books/api/v3/oauth/

## Zoho Books Model

Zoho Books objects we need:
- Contact / Customer: each WMS365 company maps to one Zoho customer/contact record.
- Item / Service: each WMS365 charge code can map to a Zoho item/service, or can be sent as a free-text invoice line if we decide not to maintain Zoho items.
- Invoice: each invoice requires the Zoho organization, customer, invoice date, and line items.
- Payments: optional readback later, so WMS365 can show whether a Zoho invoice is paid, partially paid, or overdue.

Important Zoho API requirements:
- API calls require an OAuth access token.
- The Zoho organization id is required when creating or reading accounting records.
- Invoice creation uses the customer id and line items.
- Scopes should be as narrow as possible, starting with contacts, items, invoices, and organization/settings read access.
- Data center domain must match the Zoho account region, for example `.com`, `.ca`, `.eu`, etc.

## WMS365 Billing Principle

Do not create Zoho invoices directly from operational button clicks.

Correct flow:
1. Warehouse action happens in WMS365.
2. WMS365 creates or refreshes company-scoped billing events using idempotent event keys.
3. Billing team reviews, edits, holds, voids, or approves those events.
4. WMS365 creates an invoice batch by company and billing cadence.
5. WMS365 sends the invoice batch to Zoho as a draft invoice first.
6. WMS365 stores the Zoho invoice id, invoice number, sync status, and any error response.
7. Zoho remains the system that sends invoices, receives payments, and tracks receivables unless we intentionally add more automation later.

## Company Invoices With Warehouse Rollups

Invoice ownership:
- Every invoice batch belongs to one customer company / WMS365 account.
- That customer company maps to one Zoho customer/contact.
- A customer with work in multiple warehouses should still have company-scoped invoice batches, with warehouse/service-location details stored on each billing line.
- Billing data must never be pooled into a cross-company invoice.

Warehouse visibility:
- Each billing event should store the warehouse / 3PL fulfillment location that performed the work.
- The super admin dashboard should show progress billing by warehouse and assigned accounts.
- Warehouse managers should see only the companies assigned to their warehouse / 3PL location unless they have super-admin access.
- When `All Companies` is selected, super admins can see rollup totals without breaking company-level invoice ownership.

Progress billing values to track:
- unbilled value
- held value
- ready-to-invoice value
- invoiced this period
- Zoho sync failed value
- storage value pending month end
- freight value pending final carrier cost

Recommended dashboard grouping:
- Warehouse / 3PL location
- Customer company
- Billing cadence
- Last invoice date
- Open shipped orders not billed
- Open received inbounds not billed
- Storage pending
- Ready-to-sync invoice batches
- Zoho sync status

## Current WMS365 Billing Foundation

Already present:
- `billing_fee_catalog`
- `owner_billing_rates`
- `billing_events`
- company feature flag for Billing
- company fee setup UI
- manual billing line UI
- storage billing generation
- billing ledger
- detail CSV export
- Zoho CSV export placeholder
- automatic billing hooks for receiving batch saves, shipped portal orders, and monthly storage generation

Needed next:
- invoice batch table
- Zoho connection table/settings
- Zoho customer/contact mapping per WMS365 company
- Zoho item/service mapping per WMS365 charge code
- billing cadence per company
- invoice preview/approval workflow
- direct Zoho draft invoice sync
- Zoho sync log and retry flow

## Charge Categories

Outbound order processing:
- order processing fee
- first pick fee
- additional item pick fee
- carton pick fee
- pallet pick fee
- pack fee
- label fee
- packaging supplies
- special handling
- rush fee
- address validation
- return label
- freight actual cost
- freight markup or admin fee

Inbound receiving:
- purchase order receiving fee
- pallet receiving
- carton receiving
- unit receiving
- container unload
- floor unload
- appointment scheduling
- inspection and count verification
- labeling
- put-away
- palletizing
- receipt confirmation

Storage:
- monthly pallet storage
- oversized pallet storage
- climate-controlled storage
- floor position storage
- non-stackable surcharge
- peak pallet billing adjustment
- case/bin/cubic storage if needed later

Manual / accessorial:
- special projects
- rework
- disposal
- returns handling
- labour hourly
- equipment usage
- admin fees
- integration setup

## Billing Cadence

Each company should have a billing profile:
- cadence: daily, weekly, biweekly, monthly, or manual
- invoice grouping: by order, by shipment, by week/month, storage-only, freight-only, or combined
- payment terms: due on receipt, Net 7, Net 15, Net 30
- currency: CAD or USD
- tax handling
- Zoho contact id
- default Zoho payment terms
- default Zoho invoice template if needed

Recommended default:
- Operational charges: weekly or monthly batch.
- Storage: monthly batch.
- Freight: separate freight-only or combined with processing depending on customer agreement.

## Database Additions

Zoho connection:
- `zoho_connections`
- `id`
- `provider`
- `region`
- `organization_id`
- `client_id`
- `client_secret_encrypted`
- `refresh_token_encrypted`
- `access_token_encrypted`
- `access_token_expires_at`
- `status`
- `last_tested_at`
- `last_error`
- `created_at`
- `updated_at`

Company billing profile:
- `account_name`
- `primary_fulfillment_location_code`
- `billing_cadence`
- `invoice_grouping`
- `payment_terms`
- `currency_code`
- `tax_code`
- `zoho_contact_id`
- `zoho_contact_name`
- `zoho_customer_email`
- `send_invoice_from_zoho`
- `auto_create_invoice_batch`
- `created_at`
- `updated_at`

Zoho charge mapping:
- `fee_code`
- `zoho_item_id`
- `zoho_item_name`
- `income_account_id`
- `tax_id`
- `created_at`
- `updated_at`

Invoice batches:
- `id`
- `batch_number`
- `account_name`
- `fulfillment_location_code`
- `period_start`
- `period_end`
- `cadence`
- `status`
- `subtotal`
- `tax_total`
- `freight_total`
- `total`
- `currency_code`
- `zoho_invoice_id`
- `zoho_invoice_number`
- `zoho_status`
- `zoho_url`
- `last_sync_at`
- `last_sync_error`
- `created_by`
- `created_at`
- `updated_at`

Billing events additions:
- `invoice_batch_id`
- `fulfillment_location_code`
- `approved_at`
- `approved_by`
- `hold_reason`
- `zoho_line_item_id`
- statuses should expand from `OPEN`, `INVOICED`, `VOID` to include `READY`, `HELD`, `SYNCING`, and `SYNC_FAILED`.

## UI Placement

Billing section should contain:
- Billing Dashboard: unbilled shipped orders, unbilled receipts, storage due, ready-to-invoice amount, sync errors.
- Company Billing Profile: cadence, terms, currency, Zoho contact mapping, invoice grouping.
- Warehouse Billing Rollup: progress billing by warehouse / 3PL location and assigned customer accounts.
- Company Fee Setup: rate card by customer.
- Billable Activity: review, edit, approve, hold, void.
- Invoice Batches: create daily/weekly/monthly batch, preview lines, push to Zoho, view Zoho result.
- Zoho Setup: connect/test Zoho, choose organization, map customers, map items, send test draft invoice.
- Exports: Zoho CSV fallback, detail CSV, audit export.

Do not put Zoho setup in the customer portal.

## Automation Triggers

When an order is shipped:
- create billing events for processing, picks, labels, packaging, special handling, and freight
- use source type `SALES_ORDER`
- use source ref/order number
- use idempotent event keys so re-saving or re-syncing cannot duplicate charges

When a shipment label is created:
- create billing events for carrier cost, freight markup, address validation, insurance, return label, package materials, and special services
- link to the sales order and shipment record

When an inbound is received:
- create billing events for receiving, container unload, count verification, put-away, palletizing, labeling, and receipt confirmation
- use source type `PURCHASE_ORDER` or `RECEIVING_BATCH`

At month end:
- calculate storage events from inventory/pallet snapshots
- keep storage billing separate from operational billing unless the company profile says to combine

Scheduled invoice job:
- runs by company billing cadence
- only includes approved/ready events
- creates a local invoice batch first
- pushes a draft invoice to Zoho
- marks events invoiced only after Zoho returns an invoice id

## Security And Controls

Required controls:
- Only super users/admins can configure Zoho credentials.
- Customer portal users cannot see billing setup, Zoho ids, or other company invoices.
- Warehouse users can capture billable activity but should not change accounting sync settings unless assigned that permission.
- All billing events must be scoped by `account_name`.
- All invoice batches must be scoped by `account_name`.
- Warehouse rollups must filter by fulfillment location access before totals are shown to non-super-admin users.
- Do not send a batch to Zoho if the company has no mapped Zoho contact.
- Do not allow duplicate Zoho invoices for the same invoice batch.
- Keep full audit notes for edits, voids, retries, and sync failures.

## Open Decisions

Before implementation, choose:
- Should WMS365 send Zoho invoices automatically, or create draft invoices for review?
- Should freight be separate from processing, or combined?
- Should storage always be separate monthly, like the current Zoho examples?
- Should each WMS365 fee be mapped to a Zoho item, or should invoice lines be free text?
- What taxes apply by customer and service type?
- Should invoice numbers come from Zoho only?
- Should WMS365 read back payment status from Zoho?

## Recommended Build Phases

Phase 1 - Harden local billing:
- add billing profiles
- add event approval/hold statuses
- add invoice batches
- add billing completeness checks for shipped orders, receipts, storage, and freight

Phase 2 - Zoho setup:
- add Zoho connection screen
- add organization test
- add customer/contact lookup and mapping
- add charge-code-to-Zoho-item mapping

Phase 3 - Draft invoice sync:
- create draft invoice in Zoho from one invoice batch
- store Zoho invoice id/number/status/url
- add retry and error log

Phase 4 - Automation:
- daily/weekly/monthly scheduled invoice batch creation
- storage month-end job
- optional automatic send from Zoho

Phase 5 - Reconciliation:
- sync Zoho invoice status and payment status back to WMS365
- show outstanding balances by company
- add aging and month-end reports
