"use strict";

const {
  APP_USER_ROLES,
  getPortalOrderById,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const CARRIER = "JBF Express";
const SHIP_DATE = "2026-10-06";
const APPLY = process.argv.includes("--apply");
const ORDERS = [
  { code: "S-ORD101178", cases: 72, pallets: 4 },
  { code: "S-ORD101177", cases: 40, pallets: 2 },
  { code: "S-ORD101176", cases: 35, pallets: 2 },
  { code: "S-ORD101175", cases: 43, pallets: 2 },
  { code: "S-ORD101174", cases: 80, pallets: 4 },
  { code: "S-ORD101173", cases: 15, pallets: 1 },
  { code: "S-ORD101172", cases: 43, pallets: 2 },
  { code: "S-ORD101170", cases: 6, pallets: 1 },
];
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Freight Closeout",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, orderCode, lock = false) {
  const orderResult = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.requested_ship_date::text,
            o.confirmed_ship_date::text,o.shipment_method,o.shipped_carrier_name,
            o.shipped_tracking_reference,o.shipment_email_status,o.fulfillment_location_id,
            fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [orderCode]
  );
  if (orderResult.rowCount !== 1) throw new Error(`Expected one exact ${orderCode}.`);
  const order = orderResult.rows[0];
  const lines = (await client.query(
    `select l.id,l.line_number,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::int allocated_quantity,
            array_remove(array_agg(distinct fl.code),null) warehouse_codes
       from portal_order_lines l
       left join portal_order_allocations a on a.order_line_id=l.id
       left join bin_locations b on b.code=a.location and b.account_name=$2 and b.fulfillment_location_id=$3
       left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
      where l.order_id=$1
      group by l.id,l.line_number,l.sku,l.requested_quantity order by l.line_number,l.id`,
    [order.id, ACCOUNT, order.fulfillment_location_id]
  )).rows;
  const shipments = (await client.query(
    `select id,status,carrier_name,tracking_reference,shipped_at from warehouse_shipments
      where order_id=$1 order by id`,
    [order.id]
  )).rows;
  const documents = (await client.query(
    `select document_category,file_name from portal_order_documents where order_id=$1 order by id`,
    [order.id]
  )).rows;
  return { order, lines, shipments, documents };
}

function validate(state, expected) {
  const errors = [];
  const total = state.lines.reduce((sum, line) => sum + Number(line.requested_quantity), 0);
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE || Number(state.order.fulfillment_location_id) !== 1) errors.push("Warehouse mismatch.");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(state.order.status)) errors.push(`Status ${state.order.status} is not eligible.`);
  if (total !== expected.cases) errors.push(`Case total ${total} does not match reviewed evidence ${expected.cases}.`);
  if (state.order.status !== "SHIPPED" && state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("Order is not fully allocated.");
  if (state.lines.some((line) => (line.warehouse_codes || []).some((code) => code !== WAREHOUSE))) errors.push("Allocation outside GW3PL-MISS.");
  if (state.order.shipped_carrier_name && state.order.shipped_carrier_name.toUpperCase() !== CARRIER.toUpperCase()) errors.push("Existing carrier conflicts.");
  if (state.order.shipped_tracking_reference) errors.push("Existing tracking/reference conflicts with reviewed no-PRO closeout.");
  return errors;
}

async function shipOne(expected) {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client, expected.code);
  });
  const errors = validate(before, expected);
  if (errors.length) return { orderCode: expected.code, outcome: "blocked", errors };
  if (!APPLY) return { orderCode: expected.code, outcome: before.order.status === "SHIPPED" ? "already-shipped" : "ready", cases: expected.cases, pallets: expected.pallets };
  if (before.order.status === "SHIPPED") return { orderCode: expected.code, outcome: "already-shipped" };

  await withTransaction(async (client) => {
    let current = await facts(client, expected.code, true);
    const currentErrors = validate(current, expected);
    if (currentErrors.length) throw new Error(currentErrors.join(" "));
    const key = `owner-wellforia-jbf-${expected.code.toLowerCase()}-20261006`;
    if (current.order.status === "RELEASED") {
      await updateAdminPortalOrderStatus(client, current.order.id, "PICKING", { idempotencyKey: `${key}-picking` }, ACTOR);
      current = await facts(client, expected.code, true);
    }
    if (current.order.status === "PICKING") {
      await updateAdminPortalOrderStatus(client, current.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
      current = await facts(client, expected.code, true);
    }
    if (current.order.status === "PICKED") {
      await updateAdminPortalOrderStatus(client, current.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
      current = await facts(client, expected.code, true);
    }
    if (current.order.status !== "STAGED") throw new Error(`Expected STAGED; found ${current.order.status}.`);
    await updateAdminPortalOrderStatus(client, current.order.id, "SHIPPED", {
      idempotencyKey: `${key}-shipped`,
      confirmedShipDate: SHIP_DATE,
      shipmentMethod: "LTL_FREIGHT",
      carrierName: CARRIER,
      trackingReference: "",
      packingSlipQuantityConfirmed: true,
      missingShipmentProofOverride: true,
      missingShipmentProofOverrideReason: "Owner explicitly approved missing load-photo bypass. Reviewed signed JBF Express batch BOL and checked packing evidence dated 2026-10-06.",
      outboundPallets: {
        totalPalletsOut: expected.pallets,
        existingPalletsOut: expected.pallets,
        newPalletsUsed: 0,
        mixedPalletsBuilt: 0,
        palletNote: `Part of reviewed JBF Express batch: 18 pallets and 334 cases total. ${expected.pallets} pallet(s) for this order.`,
      },
      note: "Owner confirmed JBF Express LTL shipment on 2026-10-06. Signed batch BOL and checked quantities reviewed; load photo explicitly waived by owner.",
      shippedLines: current.lines.map((line) => ({
        orderLineId: line.id,
        sku: line.sku,
        shippedQuantity: Number(line.requested_quantity),
      })),
    }, ACTOR);
  });

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client, expected.code);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shipped = (await client.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku", [state.order.id])).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::int quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING'
        group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    return { ...state, detail, shipped, ledger };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE || after.order.shipped_carrier_name !== CARRIER) throw new Error("Order verification failed.");
  if (after.shipped.length !== after.lines.length || after.lines.some((line) => !after.shipped.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === Number(line.requested_quantity)))) throw new Error("Shipped-line verification failed.");
  if (after.ledger.length !== after.lines.length || after.lines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === Number(line.requested_quantity)))) throw new Error("Inventory-ledger verification failed.");
  if (after.shipments.length !== 1 || after.shipments[0].status !== "SHIPPED" || after.shipments[0].carrier_name !== CARRIER) throw new Error("Warehouse-shipment verification failed.");
  return { orderCode: expected.code, outcome: "shipped", cases: expected.cases, pallets: expected.pallets, shipDate: SHIP_DATE, emailStatus: after.detail.shipmentEmailStatus };
}

async function main() {
  const results = [];
  for (const order of ORDERS) {
    try { results.push(await shipOne(order)); }
    catch (error) { results.push({ orderCode: order.code, outcome: "failed", error: error.message }); }
  }
  const summary = {
    mode: APPLY ? "apply" : "preflight",
    totalCases: ORDERS.reduce((sum, row) => sum + row.cases, 0),
    totalPallets: ORDERS.reduce((sum, row) => sum + row.pallets, 0),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (results.some((row) => ["blocked", "failed"].includes(row.outcome))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
