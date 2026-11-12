"use strict";

const {
  createInventoryMovementRecord,
  safeTransferInventoryQuantity,
  withTransaction,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE_ID = 1;
const WAREHOUSE = "GW3PL-MISS";
const DESTINATION = "GW3PL-MISS-WELLFORIA-BULK";
const RUN_KEY = "OWNER-WELLFORIA-PICKABLE-NORMALIZATION-20261104";

async function verifyScope(client) {
  const account = await client.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
  if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error("Wellforia account identity mismatch.");
  const warehouse = await client.query("select id,code,is_active from fulfillment_locations where id=$1", [WAREHOUSE_ID]);
  if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE || warehouse.rows[0].is_active !== true) {
    throw new Error("Mississauga warehouse identity mismatch.");
  }
  const destination = await client.query(
    `select code,account_name,fulfillment_location_id,location_type,is_pickable
       from bin_locations where code=$1`, [DESTINATION]
  );
  const bin = destination.rows[0];
  if (destination.rowCount !== 1 || bin.account_name !== ACCOUNT
    || Number(bin.fulfillment_location_id) !== WAREHOUSE_ID
    || bin.location_type !== "STORAGE" || bin.is_pickable !== true) {
    throw new Error("Wellforia bulk destination is not valid pickable Mississauga storage.");
  }
}

async function loadRows(client, lock = false) {
  return (await client.query(
    `with sales as (
       select a.inventory_line_id,sum(a.allocated_quantity)::integer quantity
         from portal_order_allocations a join portal_orders o on o.id=a.order_id
        where o.status in ('RELEASED','PICKING','PICKED','STAGED') group by a.inventory_line_id
     ), kits as (
       select a.inventory_line_id,sum(a.allocated_quantity)::integer quantity
         from portal_kitting_allocations a join portal_kitting_requests k on k.id=a.kitting_request_id
        where k.status in ('SUBMITTED','IN_PROGRESS') group by a.inventory_line_id
     )
     select i.*,coalesce(s.quantity,0)::integer sales_allocated,
            coalesce(k.quantity,0)::integer kitting_allocated,
            (i.quantity-coalesce(s.quantity,0)-coalesce(k.quantity,0))::integer free_quantity,
            b.account_name bin_account,b.fulfillment_location_id bin_warehouse_id,
            b.location_type bin_location_type,b.is_pickable bin_is_pickable
       from inventory_lines i
       left join sales s on s.inventory_line_id=i.id
       left join kits k on k.inventory_line_id=i.id
       left join bin_locations b on b.code=i.location
      where i.account_name=$1 and i.quantity>0
      order by i.sku,i.location,i.id${lock ? " for update of i" : ""}`,
    [ACCOUNT]
  )).rows;
}

function isValidPickable(row) {
  return row.bin_account === ACCOUNT
    && Number(row.bin_warehouse_id) === WAREHOUSE_ID
    && row.bin_location_type === "STORAGE"
    && row.bin_is_pickable === true;
}

function movePlan(rows) {
  return rows
    .filter((row) => !isValidPickable(row) && Number(row.free_quantity) > 0)
    .map((row) => ({
      lineId: String(row.id),
      sku: row.sku,
      from: row.location,
      to: DESTINATION,
      quantity: Number(row.free_quantity),
      retainedForCommitments: Number(row.quantity) - Number(row.free_quantity),
    }));
}

function summarize(rows) {
  const invalid = rows.filter((row) => !isValidPickable(row));
  return {
    inventoryLines: rows.length,
    skus: new Set(rows.map((row) => row.sku)).size,
    onHand: rows.reduce((sum, row) => sum + Number(row.quantity), 0),
    validPickable: rows.filter(isValidPickable).reduce((sum, row) => sum + Number(row.quantity), 0),
    invalidOnHand: invalid.reduce((sum, row) => sum + Number(row.quantity), 0),
    invalidFree: invalid.reduce((sum, row) => sum + Math.max(Number(row.free_quantity), 0), 0),
    invalidCommitted: invalid.reduce((sum, row) => sum + Number(row.sales_allocated) + Number(row.kitting_allocated), 0),
  };
}

async function main() {
  const result = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [RUN_KEY]);
    await verifyScope(client);
    const beforeRows = await loadRows(client, APPLY);
    const plan = movePlan(beforeRows);
    if (!APPLY) return { before: summarize(beforeRows), plan };

    for (const move of plan) {
      const source = beforeRows.find((row) => String(row.id) === move.lineId);
      await safeTransferInventoryQuantity(client, source, {
        accountName: ACCOUNT,
        location: DESTINATION,
        sku: source.sku,
        upc: source.upc || "",
        lotNumber: source.lot_number || "",
        expirationDate: source.expiration_date || "",
        trackingLevel: source.tracking_level || "CASE",
      }, move.quantity, {
        actionLabel: `normalize Wellforia ${source.sku} pickable inventory`,
        transactionType: "MOVE_LOCATION",
        sourceType: "OWNER_APPROVED_LOCATION_NORMALIZATION",
        sourceId: RUN_KEY,
        fulfillmentLocationId: WAREHOUSE_ID,
        idempotencyKey: `${RUN_KEY}:LINE:${source.id}`,
        source: "SYSTEM",
      });
      await createInventoryMovementRecord(client, {
        movementKey: `${RUN_KEY}:LINE:${source.id}`,
        accountName: ACCOUNT,
        fulfillmentLocationId: WAREHOUSE_ID,
        movementType: "TRANSFER",
        fromLocation: source.location,
        toLocation: DESTINATION,
        line: source,
        quantity: move.quantity,
        reason: `Normalize free ${source.sku} inventory into Wellforia tenant-owned pickable Mississauga storage.`,
      });
    }

    const afterRows = await loadRows(client, false);
    const after = summarize(afterRows);
    if (after.onHand !== summarize(beforeRows).onHand) throw new Error("Total Wellforia on-hand changed during location normalization.");
    if (after.invalidFree !== 0) throw new Error(`Invalid locations still contain ${after.invalidFree} uncommitted cases.`);
    return { before: summarize(beforeRows), after, plan };
  });

  console.log(JSON.stringify({
    mode: APPLY ? "APPLIED" : "PREFLIGHT",
    account: ACCOUNT,
    warehouse: WAREHOUSE,
    destination: DESTINATION,
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
