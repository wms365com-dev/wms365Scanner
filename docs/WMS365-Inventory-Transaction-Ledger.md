# WMS365 Inventory Transaction Ledger

## Purpose

`activity_log` is useful for human-readable events, but it is not enough for warehouse audit requirements. WMS365 now has an immutable `inventory_transactions` ledger for inventory movement and audit reporting.

## Table

`inventory_transactions` records:

- company/account
- warehouse and fulfillment location identifiers
- location, SKU, UPC, lot, and expiration
- transaction type
- quantity delta
- quantity before and quantity after
- source type and source id
- user id, device id, and source channel
- client and server timestamps

## Append-Only Rule

The table is protected by the `inventory_transactions_append_only` trigger. Normal updates and deletes raise an error. A future super-admin archival tool can explicitly set `wms365.allow_inventory_transaction_archive = 'on'` inside a controlled transaction.

The ledger intentionally does not use foreign keys to mutable operational tables for `user_id` and `fulfillment_location_id`; those IDs are preserved as historical facts even if the related record is later archived.

## Recorded Movement Types

- `RECEIVING`
- `PUT_AWAY`
- `PICKING`
- `SHIPPING`
- `TRANSFER`
- `ADJUSTMENT`
- `CYCLE_COUNT`
- `DELETE`
- `REVERSAL`
- `MOVE_LOCATION`
- `CONVERSION`
- `IMPORT`

## Reporting

Use:

```http
GET /api/inventory-transactions
```

Supported filters include:

- `accountName`
- `location`
- `sku`
- `upc`
- `lotNumber`
- `expirationDate`
- `transactionType`
- `sourceType`
- `userId`
- `from`
- `to`
- `limit`

This supports inventory movement history, inventory by location, inventory by lot, inventory by expiry, and user activity history.

## Test Coverage

Run:

```powershell
npm run test:inventory-locking
```

The suite verifies:

- inventory mutations create ledger rows
- quantity before/after and deltas are correct
- simultaneous pick/ship/transfer/count operations remain safe
- failed transaction bodies do not leave partial inventory or ledger records
- reporting returns movement history rows
