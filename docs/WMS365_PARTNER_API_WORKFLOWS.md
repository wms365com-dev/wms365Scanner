# WMS365 Partner API v1 Workflows

All production applications require approval by an active customer portal user. Access tokens are short-lived and customer-scoped. Every write request must include a stable `Idempotency-Key`; retry the same request with the same key after a timeout.

## Create an Order

1. Request a token with `orders:write`.
2. `POST /api/v1/orders` with the customer PO, ship-to address, selected warehouse, and lines.
3. Store the returned order `externalId`. The API creates a draft so inventory warnings and warehouse selection can be reviewed before release.

```json
{
  "poNumber": "PO-1042",
  "requestedShipDate": "2026-08-05",
  "fulfillmentLocationId": 2,
  "shipmentMethod": "PARCEL",
  "shipToName": "Customer Receiving",
  "shipToAddress1": "100 Example Street",
  "shipToCity": "Toronto",
  "shipToState": "ON",
  "shipToPostalCode": "M1M 1M1",
  "shipToCountry": "Canada",
  "lines": [{ "sku": "SKU-100", "quantity": 4 }]
}
```

## Track Split Shipments

1. Read the order with `GET /api/v1/orders`.
2. Read `GET /api/v1/shipments`; one order may have one shipment per fulfillment warehouse.
3. Close each shipment independently with `PATCH /api/v1/shipments/{id}`. Parcel shipments require tracking. LTL/FTL requires BOL/PRO, packing slip, load image, pallet totals, and explicit shipped quantities.
4. Short quantities remain on the shipment line and appear in customer notifications.

## Adjust or Receive Inventory

Use an asynchronous `INVENTORY_RECEIPT` job rather than modifying inventory directly. Each row must identify the warehouse-scoped location, SKU, quantity, lot, expiry, and source reference where applicable. Completed rows create immutable inventory ledger entries. Invalid rows are rejected without changing stock.

```json
{
  "jobType": "INVENTORY_RECEIPT",
  "sourceFileName": "receipt-1042.csv",
  "rows": [
    { "location": "GW3PL-MISS-A01", "sku": "SKU-100", "quantity": 12, "lot": "LOT-8" }
  ]
}
```

## Process a Bulk Job

1. `POST /api/v1/jobs` and retain the returned job ID.
2. Poll `GET /api/v1/jobs` until the state is completed, completed with warnings, failed, or cancelled.
3. Compare total, processed, accepted, warning, and rejected counts.
4. Download `/api/v1/jobs/{id}/errors.csv` for row number, field, message, and suggested correction.
5. Correct only rejected rows and submit them as a new job with a new checksum and idempotency key.

## Retry Rules

- Reuse the same idempotency key only for an identical request.
- Use a new key when any request field changes.
- Follow cursor links rather than constructing cursor values.
- Treat `401` as an expired or revoked token and refresh once.
- Treat `409` as a business conflict that requires refreshed warehouse data or customer review.
