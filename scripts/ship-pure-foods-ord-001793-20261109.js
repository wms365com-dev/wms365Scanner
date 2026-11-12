"use strict";

const fs = require("node:fs");
const { APP_USER_ROLES, updateAdminPortalOrderStatus, withTransaction } = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001793";
const ACCOUNT = "PURE FOODS BY ESTEE";
const WAREHOUSE = "GW3PL-MISS";
const SHIP_DATE = "2026-11-09";
const CARRIER = "UNFI";
const PALLETS = 3;
const DOCUMENTS = [
  ["C:\\Users\\T470\\Desktop\\001793 PL.jpeg", "SHIPMENT_PACKING_SLIP", `${CODE}-checked-packing-slip.jpeg`],
  ["C:\\Users\\T470\\Desktop\\001793 BOL.jpeg", "SHIPMENT_BOL", `${CODE}-signed-bol.jpeg`],
  ["C:\\Users\\T470\\Desktop\\001793 PH.jpeg", "SHIPMENT_LOAD_PHOTO", `${CODE}-loaded-truck.jpeg`],
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
            o.shipment_method,o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,
            o.shipped_tracking_reference,o.shipment_email_status,o.fulfillment_location_id,
            o.outbound_total_pallets,fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [CODE],
  );
  if (result.rowCount !== 1) throw new Error(`Expected one exact ${CODE}.`);
  const order = result.rows[0];
  const lines = (await client.query(
    `select l.id,l.line_number,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity
       from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
      where l.order_id=$1 group by l.id,l.line_number,l.sku,l.requested_quantity order by l.line_number,l.id`,
    [order.id],
  )).rows;
  const shipments = (await client.query(
    `select id,shipment_code,status,fulfillment_location_id,shipment_method,carrier_name,
            tracking_reference,total_pallets,total_weight,weight_uom,bol_reference
       from warehouse_shipments where order_id=$1 order by id`, [order.id],
  )).rows;
  const documents = (await client.query(
    `select id,file_name,document_category from portal_order_documents where order_id=$1 order by id`, [order.id],
  )).rows;
  const preferences = (await client.query(
    `select email,notification_type,is_subscribed from customer_email_preferences
      where account_name=$1 and notification_type in ('SHIPMENT_CONFIRMATION','*')`, [ACCOUNT],
  )).rows;
  const recipientCount = Number((await client.query(
    `select count(distinct lower(email))::integer count from portal_vendor_access
      where account_name=$1 and is_active=true and nullif(trim(email),'') is not null`, [ACCOUNT],
  )).rows[0].count);
  const emailLogs = (await client.query(
    `select status,delivery_key,message_id,source_type,subject,sent_at from email_delivery_log
      where account_name=$1 and source_ref=$2 order by id`, [ACCOUNT, CODE],
  )).rows;
  return { order, lines, shipments, documents, preferences, recipientCount, emailLogs };
}

function validate(state) {
  const errors = [];
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE || Number(state.order.fulfillment_location_id) !== 1) errors.push("Warehouse mismatch.");
  if (!state.lines.length || state.lines.some((line) => Number(line.requested_quantity) <= 0)) errors.push("Order lines are invalid.");
  if (state.order.status !== "SHIPPED" && state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("Order is not fully allocated.");
  if (!["STAGED", "SHIPPED"].includes(state.order.status)) errors.push(`Expected STAGED or SHIPPED; found ${state.order.status}.`);
  const activeShipments = state.shipments.filter((row) => row.status !== "CANCELLED");
  if (activeShipments.length !== 1) errors.push("Expected exactly one active warehouse shipment.");
  const shipment = activeShipments[0];
  if (shipment && (Number(shipment.fulfillment_location_id) !== 1 || shipment.carrier_name !== CARRIER
    || Number(shipment.total_pallets) !== PALLETS || !["STAGED", "SHIPPED"].includes(shipment.status))) {
    errors.push("Staged UNFI shipment metadata mismatch.");
  }
  if (state.order.shipped_tracking_reference || shipment?.tracking_reference) errors.push("Unexpected tracking reference conflict.");
  if (!state.documents.length) errors.push("No shipment document is attached.");
  const optedOut = state.preferences.some((row) => row.is_subscribed === false && (row.email === "*" || row.notification_type === "*"));
  if (optedOut) errors.push("Pure Foods shipment confirmations are opted out.");
  if (state.recipientCount < 1) errors.push("No active Pure Foods email recipient is configured.");
  if (state.emailLogs.some((row) => row.status === "SENT" && String(row.source_type || "").includes("SHIPMENT"))) errors.push("A shipment email was already sent for this order.");
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
  console.log(JSON.stringify({
    phase: "preflight",
    errors,
    order: before.order,
    lines: before.lines.map((line) => ({ sku: line.sku, requested: Number(line.requested_quantity), allocated: Number(line.allocated_quantity) })),
    shipments: before.shipments,
    documents: before.documents,
    email: { recipientCount: before.recipientCount, preferenceRows: before.preferences.length,
      priorLogs: before.emailLogs.map((row) => ({ status: row.status, sourceType: row.source_type,
        subject: row.subject, deliveryKey: row.delivery_key, sentAt: row.sent_at })) },
  }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;

  await withTransaction(async (client) => {
    const current = await facts(client, true);
    const lockedErrors = validate(current);
    if (lockedErrors.length) throw new Error(lockedErrors.join(" "));
    if (current.order.status === "SHIPPED") return;
    const shipment = current.shipments.find((row) => row.status !== "CANCELLED");
    await updateAdminPortalOrderStatus(client, current.order.id, "SHIPPED", {
      idempotencyKey: `owner-pure-foods-${CODE.toLowerCase()}-shipped-20261109`,
      confirmedShipDate: SHIP_DATE,
      shipmentMethod: shipment.shipment_method || "LTL_FREIGHT",
      carrierName: CARRIER,
      trackingReference: "",
      packingSlipQuantityConfirmed: true,
      note: `Owner confirmed full shipment on November 9, 2026. Existing staged UNFI shipment: ${PALLETS} pallets.`,
      outboundPallets: {
        totalPalletsOut: PALLETS,
        existingPalletsOut: PALLETS,
        newPalletsUsed: 0,
        mixedPalletsBuilt: 0,
        palletNote: `Existing staged UNFI shipment confirms ${PALLETS} pallets.`,
      },
      shippedLines: current.lines.map((line) => ({
        orderLineId: line.id,
        sku: line.sku,
        shippedQuantity: Number(line.requested_quantity),
      })),
      documents: documentPayload(current.documents),
    }, ACTOR);
  });

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const shipmentLines = (await client.query(
      `select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku`, [state.order.id],
    )).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING'
        group by sku order by sku`, [ACCOUNT, String(state.order.id)],
    )).rows;
    const billing = (await client.query(
      `select count(*)::integer count from billing_events where account_name=$1 and source_ref=$2 and status<>'VOID'`, [ACCOUNT, CODE],
    ).catch(() => ({ rows: [{ count: 0 }] }))).rows[0];
    return { ...state, shipmentLines, ledger, billingCount: Number(billing.count) };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE
    || after.order.shipped_carrier_name !== CARRIER || Number(after.order.outbound_total_pallets) !== PALLETS) {
    throw new Error("Final order verification failed.");
  }
  if (after.shipmentLines.length !== after.lines.length || after.lines.some((line) => !after.shipmentLines.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === Number(line.requested_quantity)))) {
    throw new Error("Full shipped-line verification failed.");
  }
  if (after.ledger.length !== after.lines.length || after.lines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === Number(line.requested_quantity)))) {
    throw new Error("Inventory ledger verification failed.");
  }
  console.log(JSON.stringify({
    phase: "verified",
    order: CODE,
    status: after.order.status,
    shipDate: after.order.confirmed_ship_date,
    carrier: after.order.shipped_carrier_name,
    pallets: Number(after.order.outbound_total_pallets),
    shippedQuantity: after.shipmentLines.reduce((sum, row) => sum + Number(row.shipped_quantity), 0),
    shipmentEmailStatus: after.order.shipment_email_status,
    billingEvents: after.billingCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
