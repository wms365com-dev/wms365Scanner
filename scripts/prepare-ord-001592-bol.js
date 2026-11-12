"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const {
  APP_USER_ROLES,
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
  safeDeductInventoryLineQuantity,
  upsertInventoryLine,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001592";
const ACCOUNT = "ALCONA TRADING LTD";
const WAREHOUSE_ID = "143";
const SKU = "MS26062403";
const LOT = "MS26062403";
const DELIVERY_DATE = "2026-10-26";
const DELIVERY_TIME = "11:00";
const CARRIER_DISPLAY = "TO BE CONFIRMED";
const SOURCE_LOCATIONS = ["DI36AC", "DI38AA", "DI38AB", "DI38AC"];
const PALLETS = [
  { palletNumber: 1, location: "DJ32AC", weight: 1050.97, weightUom: "KG" },
  { palletNumber: 2, location: "DJ30AC", weight: 1053.24, weightUom: "KG" },
  { palletNumber: 3, location: "DJ28AC", weight: 1051.43, weightUom: "KG" },
  { palletNumber: 4, location: "DJ26AC", weight: 1053.24, weightUom: "KG" },
];
const TOTAL_KG = 4208.88;
const FILE = `WMS365_BOL_${CODE}_2026-10-26_11AM.pdf`;
const OUT = path.resolve(__dirname, "..", "outputs", "ord-001592-bol", FILE);
const ACTOR = { id: null, email: "prathab@greywolf3pl.com", full_name: "Owner-confirmed physical picks and BOL", role: APP_USER_ROLES.SUPER_ADMIN };
const NOTE = "Owner-confirmed physical pallet picks: DJ32AC 1050.97 kg; DJ30AC 1053.24 kg; DJ28AC 1051.43 kg; DJ26AC 1053.24 kg. Total 4208.88 kg. Requested delivery October 26, 2026 at 11:00 AM ET. Carrier to be confirmed.";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  let output;
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-prepare-bol`]);
    const found = await db.query(`select o.*,fl.code warehouse_code from portal_orders o
      join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1 ${APPLY ? "for update of o" : ""}`, [CODE]);
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID || row.status !== "STAGED"
      || row.shipped_at || row.po_number !== "529673" || row.shipping_reference !== "S2607S00390117"
      || String(row.shipped_carrier_name || "") !== "") throw new Error("Order scope, state, or carrier changed.");
    let order = await getPortalOrderById(db, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== SKU || Number(order.lines[0].quantity) !== 4
      || Number(order.lines[0].allocatedQuantity) !== 4 || order.warehouseShipments.length !== 1
      || order.warehouseShipments[0].status !== "STAGED") throw new Error("Order line, allocation, or shipment state changed.");
    const allocations = await db.query(`select a.*,i.account_name,i.quantity,i.upc,i.expiration_date,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id ${APPLY ? "for update of a,i" : ""}`, [row.id]);
    const alreadyMoved = allocations.rowCount === 4 && allocations.rows.every((a, i) => a.location === PALLETS[i].location);
    if (allocations.rowCount !== 4 || allocations.rows.some((a, i) =>
      a.sku !== SKU || a.lot_number !== LOT || Number(a.allocated_quantity) !== 1 || Number(a.quantity) < 1
      || a.account_name !== ACCOUNT || a.tracking_level !== "PALLET"
      || (!alreadyMoved && a.location !== SOURCE_LOCATIONS[i]))) throw new Error("Allocated pallet identities changed.");
    const bins = await db.query(`select code,is_pickable,fulfillment_location_id from bin_locations
      where upper(replace(code,'-',''))=any($1::text[])`, [PALLETS.map((p) => p.location)]);
    if (bins.rowCount !== 4 || bins.rows.some((b) => !b.is_pickable
      || (b.fulfillment_location_id && String(b.fulfillment_location_id) !== WAREHOUSE_ID))) throw new Error("A target bin is unavailable.");
    if (!alreadyMoved) {
      const targetInventory = await db.query(`select id,location,sku,lot_number,quantity from inventory_lines
        where account_name=$1 and sku=$2 and upper(location)=any($3::text[])`, [ACCOUNT, SKU, PALLETS.map((p) => p.location)]);
      if (targetInventory.rowCount) throw new Error("A target bin already contains inventory and requires review.");
    }
    const route = await db.query(`select id,status,appointment_date::text,window_start from order_routing_requests
      where order_id=$1 order by id desc ${APPLY ? "for update" : ""}`, [row.id]);
    if (route.rowCount !== 1 || !["PENDING", "CONFIRMED"].includes(route.rows[0].status)) throw new Error("Routing request state changed.");
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, status: row.status, carrier: CARRIER_DISPLAY,
        deliveryDate: DELIVERY_DATE, deliveryTime: "11:00 AM ET", pallets: PALLETS, totalWeightKg: TOTAL_KG,
        locationMovesRequired: !alreadyMoved, appointmentStatus: route.rows[0].status }));
      return;
    }
    if (!alreadyMoved) {
      const lineId = order.lines[0].id;
      await db.query("delete from portal_order_allocations where order_id=$1", [row.id]);
      for (let i = 0; i < PALLETS.length; i += 1) {
        const p = PALLETS[i], source = allocations.rows[i];
        const target = await upsertInventoryLine(db, { accountName: ACCOUNT, location: p.location, sku: SKU,
          upc: source.upc || "", lotNumber: LOT, expirationDate: source.expiration_date || "",
          trackingLevel: "PALLET", quantity: 1 }, { transactionType: "MOVE_LOCATION",
          sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION", sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: "web_admin",
          idempotencyKey: `${CODE}-${SOURCE_LOCATIONS[i]}-to-${p.location}` });
        await safeDeductInventoryLineQuantity(db, source.inventory_line_id, 1, { actionLabel: `move picked pallet ${SOURCE_LOCATIONS[i]} to ${p.location}`,
          transactionType: "MOVE_LOCATION", sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION", sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: "web_admin",
          idempotencyKey: `${CODE}-${SOURCE_LOCATIONS[i]}-to-${p.location}` });
        await db.query(`insert into portal_order_allocations
          (order_id,order_line_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity)
          values($1,$2,$3,$4,$5,$6,$7,'PALLET',1)`, [row.id, lineId, target.id, SKU, p.location, LOT, source.expiration_date || ""]);
      }
    }
    const notes = String(row.order_notes || "").includes(NOTE) ? row.order_notes : `${row.order_notes || ""}\n${NOTE}`.trim();
    await db.query(`update portal_orders set picked_pallet_details=$2::jsonb,routing_total_weight=$3,routing_weight_uom='KG',
      routing_requested_delivery_date=$4::date,requested_ship_date=$4::date,outbound_total_pallets=4,
      outbound_existing_pallets=4,outbound_new_pallets=0,outbound_mixed_pallets=0,order_notes=$5,updated_at=now()
      where id=$1`, [row.id, JSON.stringify(PALLETS), TOTAL_KG, DELIVERY_DATE, notes]);
    await db.query(`update warehouse_shipments set total_pallets=4,existing_pallets=4,new_pallets=0,mixed_pallets=0,
      total_weight=$2,weight_uom='KG',delivery_date=$3::date,updated_at=now() where order_id=$1`, [row.id, TOTAL_KG, DELIVERY_DATE]);
    await db.query(`update order_routing_requests set appointment_date=$2::date,window_start=$3::time,window_end=null,
      responder_note='Owner requested delivery October 26, 2026 at 11:00 AM ET; recipient confirmation remains pending.',updated_at=now()
      where id=$1`, [route.rows[0].id, DELIVERY_DATE, DELIVERY_TIME]);
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = { ...order, pickedPalletDetails: PALLETS, routingTotalWeight: TOTAL_KG, routingWeightUom: "KG",
      routingAppointment: { status: route.rows[0].status, appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME },
      orderNotes: `${NOTE} PRE-SHIPMENT / UNSIGNED.`, warehouseShipments: order.warehouseShipments.map((s) => ({ ...s,
        status: "STAGED", carrier: CARRIER_DISPLAY, totalPallets: 4, existingPallets: 4, newPallets: 0,
        mixedPallets: 0, totalWeight: TOTAL_KG, weightUom: "KG", deliveryDate: DELIVERY_DATE })) };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Invalid BOL PDF.");
    const existing = await db.query("select id,file_data from portal_order_documents where order_id=$1 and file_name=$2", [row.id, FILE]);
    if (existing.rowCount > 1 || (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(pdf.content))) throw new Error("Existing BOL conflicts with reviewed PDF.");
    if (!existing.rowCount) await db.query(`insert into portal_order_documents
      (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
      values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`, [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name, order.warehouseShipments[0].id]);
    const final = await db.query(`select o.status,o.shipped_at,o.picked_pallet_details,o.routing_total_weight,o.routing_weight_uom,
      s.status shipment_status,s.total_weight,s.weight_uom,s.delivery_date::text from portal_orders o
      join warehouse_shipments s on s.order_id=o.id where o.id=$1`, [row.id]);
    const v = final.rows[0];
    if (v.status !== "STAGED" || v.shipped_at || v.shipment_status !== "STAGED" || Number(v.routing_total_weight) !== TOTAL_KG
      || Number(v.total_weight) !== TOTAL_KG || v.routing_weight_uom !== "KG" || v.weight_uom !== "KG"
      || String(v.delivery_date).slice(0, 10) !== DELIVERY_DATE) throw new Error("Post-prepare verification failed.");
    await db.query("commit");
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, pdf.content);
    output = { mode: "APPLIED", order: CODE, status: "STAGED", carrier: CARRIER_DISPLAY, appointmentStatus: route.rows[0].status,
      deliveryDate: DELIVERY_DATE, deliveryTime: "11:00 AM ET", pallets: PALLETS, totalWeightKg: TOTAL_KG,
      file: OUT, pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex"), shipped: false };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
  console.log(JSON.stringify(output));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
