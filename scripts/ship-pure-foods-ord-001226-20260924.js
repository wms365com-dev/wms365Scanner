"use strict";

const fs = require("node:fs");
const {
  APP_USER_ROLES,
  getPortalOrderById,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = process.env.SHIP_ORDER_CODE || "ORD-001226";
const ACCOUNT = process.env.SHIP_ACCOUNT || "PURE FOODS BY ESTEE";
const WAREHOUSE = process.env.SHIP_WAREHOUSE || "GW3PL-MISS";
const PO = process.env.SHIP_PO || "5062741";
const SHIP_DATE = process.env.SHIP_DATE || "2026-09-24";
const CARRIER = process.env.SHIP_CARRIER || "RAFI";
const PALLETS = Number(process.env.SHIP_PALLETS || 1);
const WEIGHT_LB = Number(process.env.SHIP_WEIGHT_LB || 350);
const DOCUMENTS = [
  [process.env.SOURCE_PL_PATH || "C:\\Users\\T470\\Desktop\\001226 PL (1).jpeg", process.env.SOURCE_PL_CATEGORY || "SHIPMENT_PACKING_SLIP", `${CODE}-checked-packing-list.jpeg`],
  [process.env.SOURCE_BOL_PATH || "C:\\Users\\T470\\Desktop\\001226 BOL (1).jpeg", "SHIPMENT_BOL", `${CODE}-signed-bol.jpeg`],
  [process.env.SOURCE_PH_PATH || "C:\\Users\\T470\\Desktop\\001226 PH (1).jpeg", "SHIPMENT_PICK_HISTORY", `${CODE}-pick-history.jpeg`],
];
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Shipment",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, lock = false) {
  const result = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.po_number,
            o.requested_ship_date::text,o.confirmed_ship_date::text,o.shipped_at,
            o.shipped_carrier_name,o.shipped_tracking_reference,o.shipment_email_status,
            o.fulfillment_location_id,o.outbound_total_pallets,fl.code warehouse_code
       from portal_orders o
       join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [CODE]
  );
  if (result.rowCount !== 1) throw new Error(`Expected one exact ${CODE}.`);
  const order = result.rows[0];
  const lines = (await client.query(
    `select l.id,l.line_number,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::int allocated_quantity
       from portal_order_lines l
       left join portal_order_allocations a on a.order_line_id=l.id
      where l.order_id=$1
      group by l.id,l.line_number,l.sku,l.requested_quantity
      order by l.line_number,l.id`,
    [order.id]
  )).rows;
  const documents = (await client.query(
    `select id,file_name,document_category from portal_order_documents
      where order_id=$1 order by id`, [order.id]
  )).rows;
  return { order, lines, documents };
}

function validate(state) {
  const errors = [];
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE) errors.push("Warehouse mismatch.");
  if (state.order.po_number !== PO) errors.push("PO mismatch.");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(state.order.status)) errors.push(`Status ${state.order.status} is not shippable.`);
  if (!state.lines.length || state.lines.some((line) => Number(line.requested_quantity) <= 0)) errors.push("Order lines are missing or invalid.");
  if (state.order.status !== "SHIPPED" && state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("Order is not fully allocated for a no-shortage shipment.");
  if (state.order.shipped_carrier_name && state.order.shipped_carrier_name.toUpperCase() !== CARRIER) errors.push("Existing carrier conflicts.");
  if (state.order.shipped_tracking_reference) errors.push("Unexpected existing tracking reference.");
  return errors;
}

function documentPayload(existing) {
  const categories = new Set(existing.map((row) => row.document_category));
  return DOCUMENTS.filter(([, category]) => !categories.has(category)).map(([path, category, fileName]) => {
    if (!fs.existsSync(path)) throw new Error(`Required shipment evidence is unavailable: ${path}`);
    return {
      fileName,
      fileType: "image/jpeg",
      documentCategory: category,
      dataUrl: `data:image/jpeg;base64,${fs.readFileSync(path).toString("base64")}`,
    };
  });
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client);
  });
  const errors = validate(before);
  console.log(JSON.stringify({ phase: "preflight", errors, order: before.order,
    lines: before.lines.map((line) => ({ sku: line.sku, requested: Number(line.requested_quantity), allocated: Number(line.allocated_quantity) })),
    evidenceCount: before.documents.length, shipDate: SHIP_DATE, carrier: CARRIER, pallets: PALLETS, weight: WEIGHT_LB, weightUom: "LB",
    ownerApprovedMissingLoadPhoto: true }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;

  await withTransaction(async (client) => {
    let current = await facts(client, true);
    const lockedErrors = validate(current);
    if (lockedErrors.length) throw new Error(lockedErrors.join(" "));
    if (current.order.status === "SHIPPED") return;
    const key = `owner-pure-foods-${CODE.toLowerCase()}-shipped-${SHIP_DATE.replaceAll("-", "")}`;
    if (current.order.status === "RELEASED") {
      await updateAdminPortalOrderStatus(client, current.order.id, "PICKING", { idempotencyKey: `${key}-picking` }, ACTOR);
      current = await facts(client, true);
    }
    if (current.order.status === "PICKING") {
      await updateAdminPortalOrderStatus(client, current.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
      current = await facts(client, true);
    }
    if (current.order.status === "PICKED") {
      await updateAdminPortalOrderStatus(client, current.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
      current = await facts(client, true);
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
      missingShipmentProofOverrideReason: process.env.SHIP_OVERRIDE_REASON || "Owner explicitly approved shipment closure without a load photo on November 9, 2026; signed BOL and checked shipment records were supplied.",
      note: `Signed BOL confirms ${CARRIER} pickup on ${SHIP_DATE}. Full shipment with no shortage: ${PALLETS} pallet, ${WEIGHT_LB} lb. Owner approved missing shipment-proof override.`,
      outboundPallets: { totalPalletsOut: PALLETS, existingPalletsOut: PALLETS, newPalletsUsed: 0, mixedPalletsBuilt: 0, palletNote: `Signed BOL confirms ${PALLETS} pallet, ${WEIGHT_LB} lb.` },
      shippedLines: current.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) })),
      documents: documentPayload(current.documents),
    }, ACTOR);
  });

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shippedLines = (await client.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku", [state.order.id])).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::int quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING'
        group by sku order by sku`, [ACCOUNT, String(state.order.id)]
    )).rows;
    return { ...state, detail, shippedLines, ledger };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE || after.order.shipped_carrier_name !== CARRIER) throw new Error("Final order verification failed.");
  if (after.shippedLines.length !== after.lines.length || after.lines.some((line) => !after.shippedLines.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === Number(line.requested_quantity)))) throw new Error("Full shipped-line verification failed.");
  if (after.ledger.length !== after.lines.length || after.lines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === Number(line.requested_quantity)))) throw new Error("Inventory ledger verification failed.");
  console.log(JSON.stringify({ phase: "verified", order: CODE, status: after.order.status, shipDate: after.order.confirmed_ship_date,
    carrier: after.order.shipped_carrier_name, fullShipment: true, lineCount: after.lines.length,
    shipmentEmailStatus: after.detail.shipmentEmailStatus,
    documentCategories: after.documents.map((row) => row.document_category) }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
