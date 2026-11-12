# WMS365 Warehouse Location Isolation Rule

Effective immediately, warehouse/bin locations must not be shared across fulfillment warehouses.

## Rule

- Every warehouse-specific location must be scoped to one fulfillment warehouse.
- For companies assigned to more than one warehouse, location codes used by warehouse-specific work must start with the fulfillment warehouse code.
- Receiving stage locations must always be warehouse-specific.
- Location codes should stay short and structured: uppercase letters, numbers, and hyphens only, with a maximum of 32 characters.
- Use short operational suffixes. For example, receiving stage is `REC`, not `RECEIVING-STAGE`, for new locations.

## Examples

- `GW3PL-MISS-REC`
- `OLYMPIA-BURNABY-REC`
- `GW3PL-MISS-A01`
- `OLYMPIA-BURNABY-A01`
- `GW3PL-MISS-INV`
- `OLYMPIA-BURNABY-INV`

## Not Allowed For Multi-Warehouse Accounts

- `RECEIVING-STAGE`
- `REC`
- `A01`
- `STAGE`
- Any generic bin/location that could belong to more than one warehouse.

Legacy warehouse-prefixed receiving stage locations such as `GW3PL-MISS-RECEIVING-STAGE` remain recognized so old records keep working, but new warehouse receiving locations should use the shorter `-REC` suffix.

## Why

Inventory in WMS365 is keyed by company, SKU, and bin/location. If two physical warehouses share the same location code, inventory can appear blended even when the inbound/order is tied to a specific warehouse. Warehouse-prefixed locations keep BC, ON, and any future warehouse inventory separated during receiving, put-away, picking, and reporting.

## Current Enforcement

- Inbound receiving defaults to the selected warehouse receiving stage.
- Inbound receiving rejects locations that do not match the inbound warehouse for multi-warehouse accounts.
- Inventory posting and transfers with a warehouse context reject non-matching shared locations.
- Outbound order release and manual pick allocation only allocate stock from the order's warehouse-prefixed locations when the company has multiple warehouses.
- Inventory adjustments, transfers, count postings, pallet receiving, and investigation hold moves must also use a warehouse-prefixed location for multi-warehouse accounts.
- Investigation hold locations should use the short `-INV` suffix for the warehouse, for example `GW3PL-MISS-INV`.
