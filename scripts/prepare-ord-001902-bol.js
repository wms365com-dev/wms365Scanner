"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
  APP_USER_ROLES,
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001902";
const ACCOUNT = "ALCONA TRADING LTD";
const PO = "529674";
const WAREHOUSE_ID = "143";
const CARRIER = "Bison";
const DELIVERY_DATE = "2026-11-05";
const WINDOW_START = "11:30:00";
const WINDOW_END = "12:00:00";
const WEIGHTS_LB = [2324, 2325, 2321, 2320];
const FILE = `WMS365_BOL_${CODE}_2026-11-05_1130AM_BISON.pdf`;
const ACTOR = {
  id: null,
  email: "prathab@greywolf3pl.com",
  full_name: "Owner-confirmed staged pallets and BOL preparation",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

function dateText(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function timeText(value) {
  return String(value || "").slice(0, 8);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-prepare-bol`]);

    const found = await db.query(
      `select o.*,fl.code warehouse_code from portal_orders o
        join fulfillment_locations fl on fl.id=o.fulfillment_location_id
       where o.order_code=$1 ${APPLY ? "for update of o" : ""}`,
      [CODE]
    );
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || row.po_number !== PO
      || String(row.fulfillment_location_id) !== WAREHOUSE_ID || row.warehouse_code !== "WHS01"
      || row.status !== "STAGED" || row.shipped_at
      || String(row.ship_to_name || "").trim().toUpperCase() !== "NUTEM CUSTOM MANUFACTURING"
      || String(row.ship_to_address1 || "").trim().toUpperCase() !== "1105 CLAY AVE"
      || String(row.ship_to_postal_code || "").replace(/\s/g, "").toUpperCase() !== "L7L0A1") {
      throw new Error("Order identity, destination, warehouse, or state changed.");
    }

    let order = await getPortalOrderById(db, row.id, ACCOUNT);
    if (order.lines.length !== 1 || Number(order.lines[0].quantity) !== 4
      || Number(order.lines[0].allocatedQuantity) !== 4
      || order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== "STAGED") {
      throw new Error("Order line, allocation, or shipment state changed.");
    }
    const allocations = (await db.query(
      `select a.location,a.sku,a.lot_number,a.allocated_quantity,i.account_name,i.quantity,i.tracking_level
         from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
        where a.order_id=$1 order by a.id ${APPLY ? "for update of a,i" : ""}`,
      [row.id]
    )).rows;
    if (allocations.length !== 4 || allocations.some((allocation) => (
      !String(allocation.location || "").trim() || allocation.sku !== order.lines[0].sku
      || Number(allocation.allocated_quantity) !== 1 || Number(allocation.quantity) < 1
      || allocation.account_name !== ACCOUNT || allocation.tracking_level !== "PALLET"
    ))) throw new Error("Allocated pallet identities changed.");

    const pallets = allocations.map((allocation, index) => ({
      palletNumber: index + 1,
      location: allocation.location,
      weight: WEIGHTS_LB[index],
      weightUom: "LB",
    }));
    const totalLb = WEIGHTS_LB.reduce((sum, value) => sum + value, 0);
    const routing = await db.query(
      `select id,status,appointment_date,window_start,window_end,responded_at
         from order_routing_requests where order_id=$1 order by id desc ${APPLY ? "for update" : ""}`,
      [row.id]
    );
    if (routing.rowCount !== 1) throw new Error("Routing request identity is not unique.");
    const appointment = routing.rows[0];
    if (appointment.status !== "CONFIRMED" || !appointment.responded_at
      || dateText(appointment.appointment_date) !== DELIVERY_DATE
      || timeText(appointment.window_start) !== WINDOW_START
      || timeText(appointment.window_end) !== WINDOW_END) {
      throw new Error("Confirmed appointment date or window changed.");
    }

    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, status: row.status, carrier: CARRIER,
        appointmentStatus: appointment.status, deliveryDate: DELIVERY_DATE,
        deliveryWindow: "11:30 AM - 12:00 PM ET", pallets, totalWeightLb: totalLb }));
      return;
    }

    const note = `Carrier Bison. Confirmed delivery appointment November 5, 2026, 11:30 AM - 12:00 PM ET. `
      + `Staged pallets: ${pallets.map((pallet) => `${pallet.location} ${pallet.weight} lb`).join("; ")}. `
      + `Total ${totalLb} lb. PRE-SHIPMENT / UNSIGNED.`;
    await db.query(
      `update portal_orders set shipped_carrier_name=$2,picked_pallet_details=$3::jsonb,
              routing_total_weight=$4,routing_weight_uom='LB',routing_requested_delivery_date=$5::date,
              outbound_total_pallets=4,outbound_existing_pallets=4,outbound_new_pallets=0,
              outbound_mixed_pallets=0,updated_at=now() where id=$1`,
      [row.id, CARRIER, JSON.stringify(pallets), totalLb, DELIVERY_DATE]
    );
    await db.query(
      `update warehouse_shipments set shipment_method='LTL_FREIGHT',carrier_name=$2,
              bol_reference=$3,total_pallets=4,existing_pallets=4,new_pallets=0,mixed_pallets=0,
              total_weight=$4,weight_uom='LB',delivery_date=$5::date,updated_at=now() where order_id=$1`,
      [row.id, CARRIER, `BOL-${CODE}`, totalLb, DELIVERY_DATE]
    );

    order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = {
      ...order,
      orderNotes: note,
      pickedPalletDetails: pallets,
      routingTotalWeight: totalLb,
      routingWeightUom: "LB",
      routingAppointment: { status: "CONFIRMED", appointmentDate: DELIVERY_DATE,
        windowStart: WINDOW_START, windowEnd: WINDOW_END, displayWindow: "11:30 AM - 12:00 PM ET" },
      warehouseShipments: order.warehouseShipments.map((shipment) => ({ ...shipment,
        status: "STAGED", shipmentMethod: "LTL_FREIGHT", carrier: CARRIER,
        bolReference: `BOL-${CODE}`, pallets: { total: 4, existing: 4, new: 0, mixed: 0 },
        totalWeight: totalLb, weightUom: "LB", deliveryDate: DELIVERY_DATE })),
    };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Invalid BOL PDF.");

    const existing = await db.query("select id from portal_order_documents where order_id=$1 and file_name=$2", [row.id, FILE]);
    if (existing.rowCount > 1) throw new Error("Existing BOL identity is not unique.");
    if (existing.rowCount === 1) {
      await db.query(`update portal_order_documents set file_size=$3,file_data=$4,uploaded_by=$5,
        document_category='SHIPMENT_BOL' where order_id=$1 and file_name=$2`,
      [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name]);
    } else {
      await db.query(`insert into portal_order_documents
        (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
        values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`,
      [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name, order.warehouseShipments[0].id]);
    }
    const verify = (await db.query(
      `select o.status,o.shipped_at,o.shipped_carrier_name,o.routing_total_weight,o.routing_weight_uom,
              s.status shipment_status,s.carrier_name,s.total_pallets,s.total_weight,s.weight_uom,s.delivery_date::text,
              r.status appointment_status,r.appointment_date::text,r.window_start::text,r.window_end::text
         from portal_orders o join warehouse_shipments s on s.order_id=o.id
         join order_routing_requests r on r.order_id=o.id where o.id=$1`, [row.id])).rows[0];
    if (verify.status !== "STAGED" || verify.shipped_at || verify.shipment_status !== "STAGED"
      || verify.shipped_carrier_name !== CARRIER || verify.carrier_name !== CARRIER
      || Number(verify.total_pallets) !== 4 || Number(verify.routing_total_weight) !== totalLb
      || Number(verify.total_weight) !== totalLb || verify.routing_weight_uom !== "LB" || verify.weight_uom !== "LB"
      || dateText(verify.delivery_date) !== DELIVERY_DATE || verify.appointment_status !== "CONFIRMED"
      || dateText(verify.appointment_date) !== DELIVERY_DATE || timeText(verify.window_start) !== WINDOW_START
      || timeText(verify.window_end) !== WINDOW_END) throw new Error("Post-prepare verification failed.");

    await db.query("commit");
    console.log(JSON.stringify({ mode: "APPLIED", order: CODE, status: "STAGED", carrier: CARRIER,
      appointmentStatus: "CONFIRMED", deliveryDate: DELIVERY_DATE, deliveryWindow: "11:30 AM - 12:00 PM ET",
      pallets, totalWeightLb: totalLb, fileName: FILE, documentBytes: pdf.content.length,
      pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex"), pdfBase64: pdf.content.toString("base64"),
      shipped: false, emailsSent: 0 }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
