# Ranchers Pending Order Reconciliation

Owner scope: pending Canadian Shopify orders only. Completed and cancelled
historical orders must not be reintroduced into the active warehouse queue.
Owner subsequently approved releasing stock-backed drafts.

## Results

Verified September 18, 2026 at 16:40 UTC:

- Integration 4: `RANCHER'S CHIPS`, `f1acxk-dc.myshopify.com`.
- Warehouse 1: `GW3PL-MISS`.
- Nine Shopify API pages reconciled, 2,159 accessible orders across all countries
  and statuses, with an explicit creation-time range and count check.
- 190 accessible pending Canadian orders; all now linked to WMS orders.
- Twelve previously missing Salt & Vinegar preorders imported as Draft.
- New separate item: `RTC-SV-EA`, individual bags, 12 bags per case, zero stock.
  Product 10349591724333 and variant 52353121681709 were verified against the exact
  preorder title and 12 Pack option. No original-chip inventory was substituted.
- New WMS orders: `ORD-001121` through `ORD-001132`, 12 bags each, 144 bags total.
- 158 existing drafts released oldest first through the native allocation workflow.
- Final imported WMS counts: Released 178, Draft 12, Shipped 226, Cancelled 2;
  total 418. Every Released line was independently verified fully allocated.
- Physical original-chip stock remained 4,772 bags. Release reserves inventory;
  it does not deduct physical stock or mark orders picked, staged or shipped.
- Standard processing retained; no new rush approvals or rush charges.
- No Shopify writes or company emails during reconciliation.
- Shipment email opt-out independently reverified after the release pass.

Evidence is saved under `outputs/ranchers-order-reconciliation`:

- `20260918-123705-test.json`: native catalog, draft and stock-backed release tests,
  11 assertions, exact designated company 1510, all changes rolled back, no emails
  or Shopify writes.
- `20260918-123826-apply.json`: twelve missing orders imported.
- `20260918-123956-release.json`: 158 releases, twelve stock-blocked preorders.
- Shared regression suite: 657 passed, zero failed.

## Remaining Limits

The connection does not have `read_all_orders`. Shopify reported 240 open orders
store-wide, while only 231 were accessible in the verified 60-day window. The nine
older open orders cannot be classified by country or remaining physical quantity
with the current permission. They are not nine confirmed missing Canadian orders.
Do not claim every open order in the store has been verified until the permission
is granted and an unrestricted reconciliation passes.

The Salt & Vinegar Shopify variant still has a blank SKU. This repair maps the
reviewed product/variant identity for existing missing preorders without writing
to Shopify. Assign and map a distinct Shopify SKU before relying on the regular
five-minute importer for future orders of this variant. Do not map it to
`RTC-4OZ-EA` or share original-chip stock. Receive actual Salt & Vinegar stock before
releasing these twelve drafts.

## Operational Runner

`scripts/run-ranchers-order-reconciliation-remote.ps1` supports `audit`, `test`,
`apply` and `release`. It executes checked-in code against the explicitly pinned
main service without deploying unrelated worktree changes.

`apply` only repairs missing, reviewed, blank-SKU Salt & Vinegar preorders.
It stops for any other unreviewed missing item. `release` requires all accessible
pending orders linked first, validates exact tenant/warehouse and current Shopify
remaining quantities, then uses native per-order transactions and allocation
checks. Failed releases remain Draft and are reported. Neither command sends
company confirmations or manually advances orders past Released. This runner is
not scheduled; a new owner request is required for additional live writes.

Do not reverse these releases with direct allocation deletion. Use the normal
reopen/cancel workflow if the owner requests a reversal.
