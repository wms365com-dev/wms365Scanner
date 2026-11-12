# WMS365 Partner API Changelog

## 2026-07-30 - v1 Initial Foundation

### Added

- OAuth-style client credential and refresh-token exchange.
- Customer-scoped access tokens with explicit permissions.
- Cursor-paginated inventory, order, shipment, and asynchronous job endpoints.
- Idempotent asynchronous import submission.
- Inventory receipt, order draft, and ship-to address import job types.
- Per-row import results and downloadable CSV error reports.
- Warehouse shipment records separated from customer orders.

### Compatibility

- Existing WMS365 customer portal, warehouse, Shopify, mobile, and internal API routes are unchanged.
- Existing order IDs and order codes remain valid.
- Warehouse shipment records are created as orders move through release and fulfillment.

### Deprecations

- None.

## Versioning Policy

- Additive fields and endpoints may be introduced within `/api/v1`.
- Breaking request or response changes require a new major namespace.
- Deprecated fields will be announced here with a sunset date at least 90 days in advance.
