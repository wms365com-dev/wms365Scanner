"use strict";

const fs = require("node:fs");
const { APP_USER_ROLES, updateAdminPortalOrderStatus, withTransaction } = require("../server");
const { getPortalShipmentEmailAddressing } = require("../shipment-email-addressing");

const CODE = "ORD-001782";
const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const WAREHOUSE = "GW3PL-MISS";
const SHIP_DATE = "2026-10-28";
const CARRIER = "VITRAN";
const BOL_NUMBER = "SYYZOD511585";
const APPLY = process.argv.includes("--apply");
const BOL_PATH = process.env.SOURCE_BOL_PATH || "";
const LOAD_PATH = process.env.SOURCE_LOAD_PATH || "";
const EXPECTED = new Map([
  ["S044", 7], ["S158", 5], ["S160", 1], ["S162", 2],
  ["S163", 2], ["S164", 2], ["S165", 17], ["S166", 5],
]);
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Shipment",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, lock = false) {
  const result = await client.query(
    `select o.id, o.order_code, o.account_name, o.status, o.po_number,
            o.shipping_reference, o.shipment_method, o.confirmed_ship_date::text,
            o.shipped_at, o.shipped_carrier_name, o.shipped_tracking_reference,
            o.shipment_email_status, o.outbound_total_pallets,
            o.outbound_existing_pallets, o.outbound_new_pallets,
            o.routing_total_weight, o.routing_weight_uom, fl.code warehouse_code
       from portal_orders o
       join fulfillment_locations fl on fl.id = o.fulfillment_location_id
      where o.order_code = $1${lock ? " for update of o" : ""}`,
    [CODE]
  );
  if (result.rowCount !== 1) throw new Error(`Expected one exact ${CODE}.`);
  const order = result.rows[0];
  if (order.account_name !== ACCOUNT || order.warehouse_code !== WAREHOUSE || order.po_number !== "240674") {
    throw new Error("Company, warehouse, or PO identity mismatch.");
  }
  if (!["STAGED", "SHIPPED"].includes(order.status)) {
    throw new Error(`Expected STAGED or SHIPPED, found ${order.status}.`);
  }
  const lines = (await client.query(
    `select l.id, l.sku, l.requested_quantity,
            coalesce(sum(a.allocated_quantity), 0)::integer allocated_quantity
       from portal_order_lines l
       left join portal_order_allocations a on a.order_line_id = l.id
      where l.order_id = $1
      group by l.id, l.sku, l.requested_quantity
      order by l.id`,
    [order.id]
  )).rows;
  if (lines.length !== EXPECTED.size
    || lines.some((line) => EXPECTED.get(line.sku) !== Number(line.requested_quantity))) {
    throw new Error("Order lines no longer match the reviewed staged order.");
  }
  if (order.status !== "SHIPPED"
    && lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) {
    throw new Error("Order is not fully allocated.");
  }
  const recipients = (await client.query(
    `select distinct lower(trim(email)) email from (
       select email from portal_vendor_access where account_name = $1 and is_active = true
       union all select portal_login_email from owner_accounts where name = $1
       union all select billing_email from owner_accounts where name = $1
       union all select ap_email from owner_accounts where name = $1
     ) recipients where trim(coalesce(email, '')) <> '' order by 1`,
    [ACCOUNT]
  )).rows.map((row) => row.email);
  if (!recipients.length) throw new Error("No active Zeta shipment-confirmation recipients are configured.");
  const addressing = getPortalShipmentEmailAddressing(
    { accountName: ACCOUNT, orderCode: CODE },
    recipients,
    "support@wms365.co"
  );
  const bccCount = String(addressing.bcc || "").split(",").map((value) => value.trim()).filter(Boolean).length;
  if (addressing.to !== "support@wms365.co" || bccCount !== recipients.length
    || String(addressing.cc || "").trim()) {
    throw new Error("Live Zeta shipment email addressing is not BCC-only.");
  }
  const documents = (await client.query(
    "select id, file_name, document_category from portal_order_documents where order_id = $1 order by id",
    [order.id]
  )).rows;
  const shipments = (await client.query(
    `select id, status, carrier_name, tracking_reference, bol_reference,
            total_pallets, total_weight, weight_uom, shipped_at
       from warehouse_shipments where order_id = $1 order by id`,
    [order.id]
  )).rows;
  return { order, lines, documents, shipments, recipientCount: recipients.length };
}

function summary(state) {
  return {
    order: state.order,
    lines: state.lines.map((line) => ({
      sku: line.sku,
      ordered: Number(line.requested_quantity),
      allocated: Number(line.allocated_quantity),
    })),
    documentCategories: state.documents.map((document) => document.document_category),
    shipments: state.shipments,
    recipientCount: state.recipientCount,
    addressing: "SYSTEM_TO_WITH_COMPANY_RECIPIENTS_BCC_ONLY",
  };
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client);
  });
  console.log(JSON.stringify({
    phase: "preflight",
    evidence: { shipDate: SHIP_DATE, carrier: CARRIER, bolNumber: BOL_NUMBER,
      pallets: 1, weight: 450, weightUom: "LB" },
    ...summary(before),
  }));
  if (!APPLY) return;
  if (before.order.status === "SHIPPED") {
    console.log(JSON.stringify({ phase: "no-op", reason: "already-shipped", ...summary(before) }));
    return;
  }
  if (!BOL_PATH || !LOAD_PATH || !fs.existsSync(BOL_PATH) || !fs.existsSync(LOAD_PATH)) {
    throw new Error("Both reviewed shipment images are required.");
  }
  const bol = fs.readFileSync(BOL_PATH);
  const load = fs.readFileSync(LOAD_PATH);
  if (bol.subarray(0, 2).toString("hex") !== "ffd8"
    || load.subarray(0, 2).toString("hex") !== "ffd8") {
    throw new Error("Shipment evidence must be JPEG files.");
  }

  await withTransaction(async (client) => {
    const state = await facts(client, true);
    if (state.order.status === "SHIPPED") return;
    await client.query(
      "update portal_orders set routing_total_weight = 450, routing_weight_uom = 'LB', updated_at = now() where id = $1",
      [state.order.id]
    );
    await updateAdminPortalOrderStatus(client, state.order.id, "SHIPPED", {
      idempotencyKey: "owner-zeta-ord-001782-shipped-20261028",
      confirmedShipDate: SHIP_DATE,
      shipmentMethod: "LTL_FREIGHT",
      carrierName: CARRIER,
      trackingReference: BOL_NUMBER,
      packingSlipQuantityConfirmed: true,
      missingShipmentProofOverride: true,
      missingShipmentProofOverrideReason: "Owner supplied a signed carrier BOL and loaded-shipment photo and explicitly instructed WMS365 to close ORD-001782; no separate checked packing slip was supplied.",
      note: "Owner-provided signed Vitran BOL confirms pickup on October 28, 2026. BOL SYYZOD511585. One skid, 450 lb. Loaded photo identifies ORD-001782 pallet 1/1.",
      outboundPallets: {
        totalPalletsOut: 1,
        existingPalletsOut: 1,
        newPalletsUsed: 0,
        mixedPalletsBuilt: 1,
        palletNote: "One loaded skid, 450 lb, verified from signed BOL and loaded photo.",
      },
      shippedLines: state.lines.map((line) => ({
        orderLineId: line.id,
        sku: line.sku,
        shippedQuantity: Number(line.requested_quantity),
      })),
      documents: [
        { fileName: `${CODE}-signed-bol.jpeg`, fileType: "image/jpeg",
          documentCategory: "SHIPMENT_BOL", dataUrl: `data:image/jpeg;base64,${bol.toString("base64")}` },
        { fileName: `${CODE}-loaded.jpeg`, fileType: "image/jpeg",
          documentCategory: "SHIPMENT_LOAD_PHOTO", dataUrl: `data:image/jpeg;base64,${load.toString("base64")}` },
      ],
    }, ACTOR);
    await client.query(
      `update warehouse_shipments set bol_reference = $2, total_weight = 450,
        weight_uom = 'LB', updated_at = now() where order_id = $1`,
      [state.order.id, BOL_NUMBER]
    );
  });

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const shippedLines = (await client.query(
      "select sku, shipped_quantity from portal_order_shipment_lines where order_id = $1 order by sku",
      [state.order.id]
    )).rows;
    const ledger = (await client.query(
      `select sku, sum(quantity_delta)::integer quantity_delta
         from inventory_transactions
        where account_name = $1 and source_id = $2 and source_type = 'PORTAL_ORDER'
          and transaction_type = 'SHIPPING'
        group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    return { ...state, shippedLines, ledger };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE
    || after.order.shipped_carrier_name !== CARRIER
    || after.order.shipped_tracking_reference !== BOL_NUMBER
    || Number(after.order.outbound_total_pallets) !== 1
    || Number(after.order.outbound_existing_pallets) !== 1
    || Number(after.order.outbound_new_pallets) !== 0
    || Number(after.order.routing_total_weight) !== 450
    || after.order.routing_weight_uom !== "LB") {
    throw new Error("Post-shipment order verification failed.");
  }
  if (after.shippedLines.length !== EXPECTED.size
    || after.shippedLines.some((line) => Number(line.shipped_quantity) !== EXPECTED.get(line.sku))) {
    throw new Error("Post-shipment line verification failed.");
  }
  if (after.ledger.length !== EXPECTED.size
    || after.ledger.some((line) => -Number(line.quantity_delta) !== EXPECTED.get(line.sku))) {
    throw new Error("Inventory shipping ledger verification failed.");
  }
  if (!after.documents.some((document) => document.document_category === "SHIPMENT_BOL")
    || !after.documents.some((document) => document.document_category === "SHIPMENT_LOAD_PHOTO")) {
    throw new Error("Shipment evidence verification failed.");
  }
  if (after.shipments.length !== 1 || after.shipments[0].status !== "SHIPPED"
    || after.shipments[0].bol_reference !== BOL_NUMBER
    || Number(after.shipments[0].total_pallets) !== 1
    || Number(after.shipments[0].total_weight) !== 450
    || after.shipments[0].weight_uom !== "LB") {
    throw new Error("Warehouse shipment verification failed.");
  }
  console.log(JSON.stringify({ phase: "verified", shippedLines: after.shippedLines,
    ledger: after.ledger, ...summary(after) }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
