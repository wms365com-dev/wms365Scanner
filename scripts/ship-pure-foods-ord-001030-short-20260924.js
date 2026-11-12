"use strict";

const fs = require("node:fs");
const {
  APP_USER_ROLES,
  getPortalOrderById,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = process.env.SHIP_ORDER_CODE || "ORD-001030";
const ACCOUNT = process.env.SHIP_ACCOUNT || "PURE FOODS BY ESTEE";
const WAREHOUSE = process.env.SHIP_WAREHOUSE || "GW3PL-MISS";
const PO = process.env.SHIP_PO || "1259744";
const SHIP_DATE = process.env.SHIP_DATE || "2026-09-24";
const CARRIER = process.env.SHIP_CARRIER || "Jagjot";
const SHIPMENT_METHOD = process.env.SHIP_METHOD || "LTL_FREIGHT";
const SHORT_SKU = process.env.SHORT_SKU || "146";
const ORDERED_SHORT_SKU = Number(process.env.SHORT_ORDERED || 90);
const SHIPPED_SHORT_SKU = Number(process.env.SHORT_SHIPPED || 75);
const SHORTAGE = ORDERED_SHORT_SKU - SHIPPED_SHORT_SKU;
const PALLETS = Number(process.env.SHIP_PALLETS || 5);
const WEIGHT_LB = Number(process.env.SHIP_WEIGHT_LB || 4500);
const DOCUMENTS = [
  [process.env.SHIP_DOC_1_PATH === "NONE" ? "" : (process.env.SHIP_DOC_1_PATH || "C:\\Users\\T470\\Desktop\\ORD-001030 (1).pdf"), process.env.SHIP_DOC_1_TYPE || "application/pdf", process.env.SHIP_DOC_1_CATEGORY || "SHIPMENT_BOL", `${CODE}-shipment-record-1${(process.env.SHIP_DOC_1_TYPE || "application/pdf") === "application/pdf" ? ".pdf" : ".jpeg"}`],
  [process.env.SHIP_DOC_2_PATH === "NONE" ? "" : (process.env.SHIP_DOC_2_PATH || "C:\\Users\\T470\\Desktop\\001030-PH.jpeg"), process.env.SHIP_DOC_2_TYPE || "image/jpeg", process.env.SHIP_DOC_2_CATEGORY || "SHIPMENT_PACKING_SLIP", `${CODE}-shipment-record-2.jpeg`],
  [process.env.SHIP_DOC_3_PATH === "NONE" ? "" : (process.env.SHIP_DOC_3_PATH || "C:\\Users\\T470\\Desktop\\001030 PL.jpeg"), process.env.SHIP_DOC_3_TYPE || "image/jpeg", process.env.SHIP_DOC_3_CATEGORY || "GENERAL", `${CODE}-shipment-record-3.jpeg`],
  [process.env.SHIP_DOC_4_PATH === "NONE" ? "" : (process.env.SHIP_DOC_4_PATH || "C:\\Users\\T470\\Desktop\\001030 PL-2.jpeg"), process.env.SHIP_DOC_4_TYPE || "image/jpeg", process.env.SHIP_DOC_4_CATEGORY || "GENERAL", `${CODE}-shipment-record-4.jpeg`],
].filter(([path]) => path);
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Prathab Approved Short Shipment",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, lock = false) {
  const result = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.po_number,o.requested_ship_date::text,
            o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,
            o.shipped_tracking_reference,o.shipment_email_status,o.fulfillment_location_id,
            o.outbound_total_pallets,fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [CODE]
  );
  if (result.rowCount !== 1) throw new Error(`Expected one exact ${CODE}.`);
  const order = result.rows[0];
  const lines = (await client.query(
    `select l.id,l.line_number,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::int allocated_quantity
       from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
      where l.order_id=$1 group by l.id,l.line_number,l.sku,l.requested_quantity
      order by l.line_number,l.id`, [order.id]
  )).rows;
  const documents = (await client.query(
    "select id,file_name,document_category from portal_order_documents where order_id=$1 order by id",
    [order.id]
  )).rows;
  const shipments = (await client.query(
    `select id,status,shipment_method,carrier_name,total_pallets,total_weight,weight_uom,delivery_date::text
       from warehouse_shipments where order_id=$1 order by id`, [order.id]
  )).rows;
  return { order, lines, documents, shipments };
}

function expectedShipped(line) {
  return line.sku === SHORT_SKU ? SHIPPED_SHORT_SKU : Number(line.requested_quantity);
}

function validate(state) {
  const errors = [];
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE) errors.push("Warehouse mismatch.");
  if (PO !== "*" && state.order.po_number !== PO) errors.push("PO mismatch.");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(state.order.status)) errors.push(`Status ${state.order.status} is not shippable.`);
  const shortLines = state.lines.filter((line) => line.sku === SHORT_SKU);
  if (shortLines.length !== 1 || Number(shortLines[0].requested_quantity) !== ORDERED_SHORT_SKU) errors.push(`SKU ${SHORT_SKU} ordered quantity is not the approved ${ORDERED_SHORT_SKU} cases.`);
  if (!state.lines.length || state.lines.some((line) => Number(line.requested_quantity) <= 0)) errors.push("Order lines are missing or invalid.");
  if (state.order.status !== "SHIPPED" && state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("The staged order is not fully allocated before short-shipment posting.");
  if (CARRIER !== "AUTO" && state.order.shipped_carrier_name && state.order.shipped_carrier_name.toUpperCase() !== CARRIER.toUpperCase()) errors.push("Existing carrier conflicts.");
  if (state.order.shipped_tracking_reference) errors.push("Unexpected existing tracking reference.");
  return errors;
}

function documentPayload(existing) {
  const categoriesAndNames = new Set(existing.map((row) => `${row.document_category}:${row.file_name}`));
  return DOCUMENTS.filter(([, , category, fileName]) => !categoriesAndNames.has(`${category}:${fileName}`)).map(([path, fileType, category, fileName]) => {
    if (!fs.existsSync(path)) throw new Error(`Required shipment evidence is unavailable: ${path}`);
    return { fileName, fileType, documentCategory: category, dataUrl: `data:${fileType};base64,${fs.readFileSync(path).toString("base64")}` };
  });
}

async function main() {
  const before = await withTransaction(async (client) => { await client.query("set transaction read only"); return facts(client); });
  const errors = validate(before);
  console.log(JSON.stringify({ phase: "preflight", errors, order: before.order,
    lines: before.lines.map((line) => ({ sku: line.sku, ordered: Number(line.requested_quantity), allocated: Number(line.allocated_quantity), plannedShipped: expectedShipped(line) })),
    approvedShortage: { sku: SHORT_SKU, ordered: ORDERED_SHORT_SKU, shipped: SHIPPED_SHORT_SKU, short: SHORTAGE },
    shipDate: SHIP_DATE, carrier: CARRIER, pallets: PALLETS, weightLb: WEIGHT_LB,
    savedDocuments: before.documents, savedShipments: before.shipments }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;

  await withTransaction(async (client) => {
    let current = await facts(client, true);
    const lockedErrors = validate(current);
    if (lockedErrors.length) throw new Error(lockedErrors.join(" "));
    if (current.order.status === "SHIPPED") return;
    const key = `owner-pure-foods-${CODE.toLowerCase()}-short-shipped-${SHIP_DATE.replaceAll("-", "")}`;
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
      shipmentMethod: SHIPMENT_METHOD,
      carrierName: CARRIER,
      trackingReference: "",
      packingSlipQuantityConfirmed: true,
      missingShipmentProofOverride: true,
      missingShipmentProofOverrideReason: process.env.SHIP_OVERRIDE_REASON || "Prathab explicitly approved historical closeout using the supplied BOL and checked shipment records without a load photo on November 9, 2026.",
      note: `Prathab approved short shipment. SKU ${SHORT_SKU}: ${SHIPPED_SHORT_SKU} cases shipped of ${ORDERED_SHORT_SKU}; shortage ${SHORTAGE}. Every other line shipped in full. ${PALLETS} pallets, ${WEIGHT_LB} lb, carrier ${CARRIER}.`,
      outboundPallets: { totalPalletsOut: PALLETS, existingPalletsOut: PALLETS, newPalletsUsed: 0, mixedPalletsBuilt: 0, palletNote: `Supplied BOL confirms ${PALLETS} pallets and ${WEIGHT_LB} lb.` },
      shippedLines: current.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: expectedShipped(line) })),
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
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE || after.order.shipped_carrier_name.toUpperCase() !== CARRIER.toUpperCase()) throw new Error("Final order verification failed.");
  if (after.shippedLines.length !== after.lines.length || after.lines.some((line) => !after.shippedLines.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === expectedShipped(line)))) throw new Error("Short shipped-line verification failed.");
  const positiveShipmentLines = after.lines.filter((line) => expectedShipped(line) > 0);
  if (after.ledger.length !== positiveShipmentLines.length || positiveShipmentLines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === expectedShipped(line)))) throw new Error("Inventory ledger verification failed.");
  if (after.ledger.some((row) => row.sku === SHORT_SKU) && SHIPPED_SHORT_SKU === 0) throw new Error("Zero-shipped shortage SKU unexpectedly changed inventory.");
  console.log(JSON.stringify({ phase: "verified", order: CODE, status: after.order.status, shipDate: after.order.confirmed_ship_date,
    carrier: after.order.shipped_carrier_name, lineCount: after.lines.length,
    shortShipment: { sku: SHORT_SKU, ordered: ORDERED_SHORT_SKU, shipped: SHIPPED_SHORT_SKU, short: SHORTAGE },
    shipmentEmailStatus: after.detail.shipmentEmailStatus, documentCount: after.documents.length }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
