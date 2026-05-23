# WMS365 Inventory Locking

## Purpose

Inventory-changing operations must be safe when multiple warehouse users work at the same time. WMS365 now centralizes inventory mutations behind transaction-safe helpers that use row locks, atomic quantity updates, and retry handling for database deadlocks or serialization failures.

## Protected Operations

- Shipping allocated portal orders through `consumePortalOrderInventory`
- Releasing portal orders and creating pick allocations
- Receiving and count posting through `upsertInventoryLine` and `postInventoryCountAdjustment`
- Quantity removal and inventory line deletion
- Transfers, put-away, item conversion, and location moves
- Bulk inventory worksheet updates

## Locking Rules

- Inventory rows are read with `SELECT ... FOR UPDATE` before a quantity decision is made.
- Inventory count records are locked before posting so a count can only post once.
- Portal order rows are locked before warehouse status transitions so double-pick and double-ship requests see the latest order state.
- Inserts and adds use `INSERT ... ON CONFLICT ... DO UPDATE` against the inventory identity index:
  `account_name, location, sku, lot_number, expiration_date`.
- Negative inventory is blocked by helper validation and the database quantity check.

## Main Helpers

- `withTransaction(handler, options)`
  Wraps operations in `BEGIN` / `COMMIT` / `ROLLBACK` and retries retryable database lock failures.

- `lockInventoryLineById(client, lineId)`
  Locks an inventory row with `FOR UPDATE`.

- `setInventoryQuantity(client, lineId, quantity, options)`
  Sets or clears a line after validating that the final quantity is not negative.

- `safeDeductInventoryLineQuantity(client, lineOrId, quantity, options)`
  Locks the row, verifies available on-hand quantity, and deducts atomically.

- `safeTransferInventoryQuantity(client, sourceLine, destinationItem, quantity, options)`
  Deducts from the locked source row and upserts the destination row.

## Failed Lock Logging

Retryable transaction failures and unsafe inventory races are logged with `logInventoryLockFailure`. When the database is ready, WMS365 records an `activity_log` row with type `security` so support can see failed lock attempts and investigate repeated contention.

## Test Coverage

Run:

```powershell
npm run test:inventory-locking
```

The test suite covers:

- Two simultaneous picks against the same inventory
- Two simultaneous transfers
- Simultaneous inventory count posting
- Shipping and transferring the same stock at the same time
- Negative inventory prevention
- Rollback validation after a failed transaction body
