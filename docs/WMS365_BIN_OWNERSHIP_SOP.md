# WMS365 BIN Ownership and Warehouse Assignment SOP

## Purpose

Prevent inventory from appearing out of stock when physical stock exists but its BIN lacks an explicit customer or fulfillment-warehouse assignment.

## Required rule

Every BIN containing inventory must have:

- exactly one `account_name` matching every inventory row in the BIN;
- a `fulfillment_location_id` when that company has more than one active warehouse;
- a code beginning with the assigned warehouse code for multi-warehouse companies;
- an intentional `location_type` and `is_pickable` value.

Never infer ownership from a customer name alone. The BIN record is the authoritative warehouse boundary.

## Standard operating procedure

### Before inventory is received, imported, adjusted, or transferred

1. Select the customer company and fulfillment warehouse.
2. Create or select a warehouse-prefixed BIN, such as `GW3PL-MISS-A01`.
3. Confirm the BIN card shows the same company and warehouse as the transaction.
4. Do not use a blank-owner BIN or a generic BIN for a multi-warehouse company.

### After a bulk import or migration

1. Run the read-only audit in the target environment:

   `railway run --service wms365Scanner --environment production -- node scripts/audit-bin-location-ownership.js --summary-only --fail-on-findings`

2. Treat any finding as a release blocker.
3. Resolve each finding from physical/source records; never guess the warehouse.
   Safe metadata-only repairs may use `scripts/repair-safe-bin-location-ownership.js` when the company has one warehouse or the BIN has exactly one matching warehouse-code prefix. Run it without confirmation first, then apply only with `--confirm=APPLY-SAFE-BIN-OWNERSHIP`.
4. Re-run the audit until `findingCount` is zero.
5. Verify a test-company draft order sees only the selected warehouse's stock.

### Daily exception handling

When an order reports out of stock unexpectedly:

1. Do not add inventory or change the order first.
2. Compare requested quantity, active reservations, pickable stock, BIN company, and BIN warehouse.
3. Correct metadata only when the physical warehouse is unambiguous.
4. Recheck portal availability and confirm another warehouse remains isolated.
5. Record the incident, affected BINs, root cause, correction, and verification result.

## Ownership

- Warehouse operations owns the physical BIN-to-warehouse truth.
- WMS365 administrators own master-data correction and audit review.
- Engineering owns automated enforcement, migrations, and regression tests.

## Acceptance test

For a test company assigned to two warehouses:

1. Adding stock to a correctly prefixed BIN automatically persists company and warehouse ownership.
2. Reusing that BIN for another company or warehouse is rejected.
3. A draft order sees stock from its selected warehouse only.
4. The audit returns zero findings after setup.
5. Existing single-warehouse legacy stock remains readable.

## Rollback

If enforcement blocks a legitimate workflow, do not remove tenant or warehouse checks. Capture the rejected company, warehouse, BIN code, and transaction type in the test company, correct the caller to provide explicit scope, and redeploy through the normal release process.
