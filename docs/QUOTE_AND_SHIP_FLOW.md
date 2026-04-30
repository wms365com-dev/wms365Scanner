# WMS365 Quote & Ship Flow

Last reviewed: 2026-04-29

Purpose:
- Internal build reference for the WMS365 shipment quoting and label workflow.
- Keep this aligned with Sales Orders, item dimensions, package records, carrier integrations, and billing capture.
- This is a planned operational workflow, not just an integration settings screen.

## Target Flow

1. Store or portal orders enter WMS365 as `DRAFT` or `RELEASED` based on integration settings.
2. Warehouse picks the order.
3. After `PICKED`, user opens `Pack / Ship`.
4. User chooses whether to ship as-is or pack into package, pallet, courier pak, or envelope.
5. Package details prefill from item master dimensions and weight, then user can override actual values.
6. WMS365 saves package records against the sales order.
7. `Quote & Ship` loads the saved ship-from, ship-to, package, service, billing, and reference data.
8. User requests rates from ClickShip or direct carrier APIs.
9. User selects a carrier/service and creates the label.
10. Label, tracking, rate, service, shipment cost, and billing charges are saved to the sales order.
11. Order moves to shipped when the warehouse confirms shipment.

## Navigation Placement

Planned desktop section:
- Group: `Outbound`
- Section title: `Quote & Ship`
- Suggested section key: `shipping`

Relationship to other sections:
- `Sales Orders` owns order entry, release, pick, stage, and order drill-in.
- `Quote & Ship` owns package capture, rate shopping, label creation, and shipment cost capture.
- `Integrations` owns carrier and marketplace credentials only.
- `Billing` owns month-end review of captured shipping and handling charges.

## Quote Form Field Map

### Packaging Type

Options:
- Package
- Pallet
- Courier Pak
- Envelope

Options to support:
- Save as packaging default
- Package template lookup
- Package quantity
- Imperial / metric unit toggle

### Ship From

Source:
- Default warehouse location.
- Can be overridden by user if needed.

Fields:
- Company name
- Address 1
- Address 2
- Unit / floor number
- City
- Province / state
- Postal / ZIP code
- Country
- Residential address flag
- Contact name
- Phone number
- Extension
- Email address
- Instructions
- Ship date
- Ready time
- Close time

Options:
- Validate address
- Update location
- Save as new default
- Swap ship-from and ship-to when appropriate

### Ship To

Source:
- Sales order ship-to address.
- Customer/contact address book later.

Fields:
- Company name
- Contact ID
- Address 1
- Address 2
- Unit / floor number
- City
- Province / state
- Postal / ZIP code
- Country
- Residential address flag
- Contact name
- Phone number
- Extension
- Email address
- Instructions
- Ready time
- Close time
- Billing reference code

Options:
- Validate address
- Address book lookup
- Save contact to address book
- Add multiple billing/reference codes
- No signature required
- Signature required
- Adult signature required
- Return label

### Package Details

Fields:
- Quantity
- Length
- Width
- Height
- Weight
- Description
- Special handling required
- Dangerous goods
- Total cost value of goods being shipped
- Currency: CAD / USD
- Insurance type

Sources:
- Item master dimensions and weight.
- Sales order line quantities.
- Saved package templates.
- Manual override by shipping user.

### Rate Results

Rate rows should show:
- Carrier
- Service
- Delivery estimate
- Base rate
- Fuel/surcharges/taxes if provider returns them
- Total cost
- Currency
- Provider source: ClickShip, UPS, FedEx, Canada Post, etc.

Actions:
- Refresh rates
- Select rate
- Buy / create label
- Save quote only
- Mark customer-billed cost

### Label Output

Save against the sales order:
- Carrier
- Service
- Tracking number
- Label PDF or ZPL
- Commercial invoice if provided
- Return label if created
- Rate cost
- Currency
- Package count
- Shipment date
- Provider response reference

## Carrier Provider Strategy

Use a provider adapter layer so WMS365 does not lock into one carrier source.

Provider types:
- ClickShip aggregate quoting/label API
- Direct UPS API
- Direct FedEx API
- Direct Canada Post API
- Manual carrier entry fallback

Internal adapter methods:
- Validate address
- Get rates
- Create label
- Void label
- Track shipment

## Required Data Model

Planned tables or logical records:
- carrier_connections
- warehouse_ship_locations
- address_book_contacts
- package_templates
- sales_order_packages
- shipment_quotes
- shipment_labels
- shipment_events
- billing_events

Important links:
- shipment records must link to company/account
- shipment records must link to sales order
- package records must link to sales order and line details when possible
- billing events must link back to shipment/order for audit

## Billing Capture

Capture billing-ready events when:
- package is created, if packaging material is billable
- label is created, if label fee applies
- shipping rate is selected or label purchased
- order is marked shipped

Charge categories:
- shipping cost
- label fee
- package material
- pick/pack fee
- special handling
- dangerous goods handling
- return label fee
- address validation fee if passed through

## Build Phases

Phase 1:
- Add `Quote & Ship` UI shell.
- Add pack/ship package form after picked orders.
- Save package records.
- Use manual/mock rates to confirm workflow.

Phase 2:
- Add carrier connection setup under `Integrations`.
- Add ClickShip adapter first if API credentials are available.
- Save quote results.

Phase 3:
- Create labels.
- Save label files/tracking to order.
- Capture billing events.

Phase 4:
- Add direct UPS, FedEx, and Canada Post adapters.
- Add address book and package templates.
- Add label void/reprint/tracking.
