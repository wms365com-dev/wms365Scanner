"use strict";

const {
  APP_USER_ROLES,
  getPortalOrderById,
  getShipmentMethodTrackingConflict,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const APPLY = process.argv.includes("--apply");
const ACTOR = { id: null, email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Carrier-Verified Closeout",
  role: APP_USER_ROLES.SUPER_ADMIN };
const ROWS = [
  ["S-ORD101179", "520786749744", "2026-10-07", 8],
  ["S-ORD101180", "520786828191", "2026-10-07", 8],
  ["S-ORD101181", "520786911211", "2026-10-07", 19],
  ["S-ORD101214", "520799202277", "2026-10-14", 14],
  ["S-ORD101215", "520799215188", "2026-10-14", 6],
  ["S-ORD101216", "520799226656", "2026-10-14", 7],
  ["S-ORD101229", "520810152980", "2026-10-21", 18],
  ["S-ORD101230", "520810193380", "2026-10-21", 8],
  ["S-ORD101231", "520810564457", "2026-10-21", 3],
  ["S-ORD101234", "520824171489", "2026-10-28", 15],
  ["S-ORD101235", "520824202383", "2026-10-28", 5],
  ["S-ORD101236", "520824244526", "2026-10-28", 12],
].map(([orderCode, tracking, shipDate, quantity]) => ({ orderCode, tracking, shipDate, quantity }));

async function facts(client, row, lock = false) {
  const result = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.requested_ship_date::text,
            o.shipment_method,o.shipped_carrier_name,o.shipped_tracking_reference,
            o.confirmed_ship_date::text,o.shipment_email_status,fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [row.orderCode]
  );
  if (result.rowCount !== 1) throw new Error(`${row.orderCode}: expected one exact order.`);
  const order = result.rows[0];
  const lines = (await client.query(
    `select l.id,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity
       from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
      where l.order_id=$1 group by l.id,l.sku,l.requested_quantity order by l.id`,
    [order.id]
  )).rows;
  const labels = (await client.query(
    `select id from portal_order_documents where order_id=$1
      and (document_category='SHIPPING_LABEL' or file_name ~* '(shipping[- _]?label|purolator)')`,
    [order.id]
  )).rows;
  const duplicates = (await client.query(
    `select order_code from portal_orders where id<>$1
      and upper(trim(coalesce(shipped_tracking_reference,'')))=upper($2)`,
    [order.id, row.tracking]
  )).rows;
  return { order, lines, labels, duplicates };
}

function validate(row, state) {
  const errors = [];
  const { order, lines, labels, duplicates } = state;
  if (order.account_name !== ACCOUNT || order.warehouse_code !== WAREHOUSE) errors.push("tenant or warehouse mismatch");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) errors.push(`invalid status ${order.status}`);
  if (order.requested_ship_date !== row.shipDate) errors.push("requested date changed");
  if (!labels.length) errors.push("shipping label document missing");
  if (!lines.length || lines.reduce((sum, line) => sum + Number(line.requested_quantity), 0) !== row.quantity) errors.push("quantity mismatch");
  if (order.status !== "SHIPPED" && lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("not fully allocated");
  if (duplicates.length) errors.push(`tracking duplicated on ${duplicates.map((x) => x.order_code).join(",")}`);
  const conflict = getShipmentMethodTrackingConflict({ shipmentMethod: "PARCEL", carrierName: "Purolator", trackingReference: row.tracking });
  if (conflict) errors.push(conflict.message || "tracking conflict");
  if (order.shipped_carrier_name && order.shipped_carrier_name.toUpperCase() !== "PUROLATOR") errors.push("carrier conflict");
  if (order.shipped_tracking_reference && order.shipped_tracking_reference !== row.tracking) errors.push("tracking conflict");
  return errors;
}

async function processRow(row) {
  return withTransaction(async (client) => {
    let state = await facts(client, row, APPLY);
    const errors = validate(row, state);
    if (errors.length) throw new Error(`${row.orderCode}: ${errors.join("; ")}`);
    if (!APPLY) return { orderCode: row.orderCode, outcome: "ready", shipDate: row.shipDate };
    if (state.order.status === "SHIPPED") return { orderCode: row.orderCode, outcome: "already-shipped", shipDate: state.order.confirmed_ship_date };
    const key = `wellforia-purolator-closeout-${row.orderCode.toLowerCase()}-${row.tracking}`;
    if (state.order.status === "RELEASED") {
      await updateAdminPortalOrderStatus(client, state.order.id, "PICKING", { idempotencyKey: `${key}-picking` }, ACTOR);
      state = await facts(client, row, true);
    }
    if (state.order.status === "PICKING") {
      await updateAdminPortalOrderStatus(client, state.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
      state = await facts(client, row, true);
    }
    if (state.order.status === "PICKED") {
      await updateAdminPortalOrderStatus(client, state.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
      state = await facts(client, row, true);
    }
    if (state.order.status !== "STAGED") throw new Error(`${row.orderCode}: expected STAGED, found ${state.order.status}.`);
    await updateAdminPortalOrderStatus(client, state.order.id, "SHIPPED", {
      idempotencyKey: `${key}-shipped`, confirmedShipDate: row.shipDate,
      shipmentMethod: "PARCEL", carrierName: "Purolator", trackingReference: row.tracking,
      packingSlipQuantityConfirmed: true,
      note: `Official Purolator public tracking confirmed the complete shipment was delivered; carrier shipment date ${row.shipDate}.`,
      shippedLines: state.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) })),
    }, ACTOR);
    return { orderCode: row.orderCode, outcome: "shipped", shipDate: row.shipDate };
  });
}

async function verify(row) {
  return withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client, row);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const ledger = (await client.query(
      `select coalesce(sum(quantity_delta),0)::integer quantity from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING'`,
      [ACCOUNT, String(state.order.id)]
    )).rows[0];
    const shipment = (await client.query(
      `select status,carrier_name,tracking_reference from warehouse_shipments where order_id=$1`,
      [state.order.id]
    )).rows;
    if (state.order.status !== "SHIPPED" || state.order.confirmed_ship_date !== row.shipDate
      || state.order.shipped_carrier_name.toUpperCase() !== "PUROLATOR"
      || state.order.shipped_tracking_reference !== row.tracking
      || -Number(ledger.quantity) !== row.quantity || shipment.length !== 1
      || shipment[0].status !== "SHIPPED" || shipment[0].tracking_reference !== row.tracking) {
      throw new Error(`${row.orderCode}: post-shipment verification failed.`);
    }
    return { orderCode: row.orderCode, status: state.order.status, shipDate: state.order.confirmed_ship_date,
      carrier: state.order.shipped_carrier_name, tracking: state.order.shipped_tracking_reference,
      quantity: row.quantity, shipmentEmailStatus: detail.shipmentEmailStatus };
  });
}

async function main() {
  const results = [];
  for (const row of ROWS) {
    try { results.push(await processRow(row)); }
    catch (error) { results.push({ orderCode: row.orderCode, outcome: "failed", error: error.message || String(error) }); }
  }
  const failed = results.filter((row) => row.outcome === "failed");
  const verification = [];
  if (APPLY) {
    for (const row of ROWS.filter((candidate) => !failed.some((failure) => failure.orderCode === candidate.orderCode))) {
      try { verification.push(await verify(row)); }
      catch (error) { failed.push({ orderCode: row.orderCode, outcome: "verification-failed", error: error.message || String(error) }); }
    }
  }
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "preflight", results, verification, failed }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
