"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { APP_USER_ROLES, buildPortalOrderBillOfLadingPdfAttachment, getPortalOrderBillOfLadingReadiness, getPortalOrderById } = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001592";
const ACCOUNT = "ALCONA TRADING LTD";
const CARRIER = "Bison";
const DELIVERY_DATE = "2026-10-26";
const WINDOW_START = "10:00";
const WINDOW_END = "11:00";
const LOCATIONS = ["DJ32AC", "DJ30AC", "DJ28AC", "DJ26AC"];
const WEIGHTS = [1050.97, 1053.24, 1051.43, 1053.24];
const TOTAL_KG = 4208.88;
const FILE = "WMS365_BOL_ORD-001592_2026-10-26_11AM_BISON_CORRECTED.pdf";
const OUT = path.resolve(__dirname, "..", "outputs", "ord-001592-bol", FILE);
const ACTOR = { id: null, email: "prathab@greywolf3pl.com", full_name: "Owner-confirmed Bison BOL revision", role: APP_USER_ROLES.SUPER_ADMIN };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-bison-bol-revision`]);
    const q = await db.query(`select o.*,s.id shipment_id,s.status shipment_status,s.carrier_name shipment_carrier,
      s.total_weight shipment_weight,s.weight_uom shipment_weight_uom,s.delivery_date::text delivery_date,
      r.status appointment_status,r.appointment_date::text appointment_date,r.window_start,r.window_end
      from portal_orders o join warehouse_shipments s on s.order_id=o.id
      join order_routing_requests r on r.order_id=o.id where o.order_code=$1 ${APPLY ? "for update of o,s" : ""}`, [CODE]);
    if (q.rowCount !== 1) throw new Error("Order, shipment, or routing identity is not unique.");
    const row = q.rows[0];
    if (row.account_name !== ACCOUNT || row.status !== "STAGED" || row.shipment_status !== "STAGED" || row.shipped_at
      || String(row.fulfillment_location_id) !== "143" || row.po_number !== "529673"
      || !["", CARRIER].includes(String(row.shipped_carrier_name || "")) || !["", CARRIER].includes(String(row.shipment_carrier || ""))
      || Number(row.routing_total_weight) !== TOTAL_KG || Number(row.shipment_weight) !== TOTAL_KG
      || row.routing_weight_uom !== "KG" || row.shipment_weight_uom !== "KG"
      || String(row.delivery_date).slice(0, 10) !== DELIVERY_DATE || String(row.appointment_date).slice(0, 10) !== DELIVERY_DATE
      || row.appointment_status !== "CONFIRMED" || String(row.window_start).slice(0, 5) !== WINDOW_START
      || String(row.window_end).slice(0, 5) !== WINDOW_END) throw new Error("Live staged order details changed.");
    const pallets = row.picked_pallet_details || [];
    if (pallets.length !== 4 || pallets.some((p, i) => p.location !== LOCATIONS[i] || Number(p.weight) !== WEIGHTS[i] || p.weightUom !== "KG")) throw new Error("Pallet details changed.");
    const allocations = await db.query(`select a.location,a.sku,a.lot_number,a.allocated_quantity,i.quantity
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id where a.order_id=$1 order by a.id`, [row.id]);
    if (allocations.rowCount !== 4 || allocations.rows.some((a, i) => a.location !== LOCATIONS[i] || a.sku !== "MS26062403"
      || a.lot_number !== "MS26062403" || Number(a.allocated_quantity) !== 1 || Number(a.quantity) < 1)) throw new Error("Allocations changed.");
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ ready: true, order: CODE, status: row.status, carrier: CARRIER,
        deliveryDate: DELIVERY_DATE, deliveryWindow: "10:00-11:00 AM ET", appointmentStatus: row.appointment_status }));
      return;
    }
    await db.query("update portal_orders set shipped_carrier_name=$2,updated_at=now() where id=$1", [row.id, CARRIER]);
    await db.query("update warehouse_shipments set carrier_name=$2,updated_at=now() where id=$1", [row.shipment_id, CARRIER]);
    const order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = { ...order, shippedCarrierName: CARRIER, pickedPalletDetails: pallets,
      routingAppointment: { status: row.appointment_status, appointmentDate: DELIVERY_DATE,
        windowStart: WINDOW_START, windowEnd: WINDOW_END, displayWindow: "10:00 - 11:00 AM ET" },
      orderNotes: `Carrier ${CARRIER}. Confirmed delivery window October 26, 2026 from 10:00 to 11:00 AM ET. Four pallets total 4208.88 kg. PRE-SHIPMENT / UNSIGNED.`,
      warehouseShipments: order.warehouseShipments.map((s) => ({ ...s, status: "STAGED", carrier: CARRIER,
        totalPallets: 4, existingPallets: 4, newPallets: 0, mixedPallets: 0, totalWeight: TOTAL_KG,
        weightUom: "KG", deliveryDate: DELIVERY_DATE })) };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Invalid revised BOL PDF.");
    const existing = await db.query("select id,file_data from portal_order_documents where order_id=$1 and file_name=$2", [row.id, FILE]);
    if (existing.rowCount > 1 || (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(pdf.content))) throw new Error("Existing revised BOL conflicts.");
    await db.query(`update portal_order_documents set document_category='GENERAL'
      where order_id=$1 and file_name in ('WMS365_BOL_ORD-001592_2026-10-26_11AM.pdf',
        'WMS365_BOL_ORD-001592_2026-10-26_11AM_BISON_REVISED.pdf') and document_category='SHIPMENT_BOL'`, [row.id]);
    if (!existing.rowCount) await db.query(`insert into portal_order_documents
      (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
      values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`, [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name, row.shipment_id]);
    await db.query("commit");
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, pdf.content);
    console.log(JSON.stringify({ applied: true, order: CODE, status: "STAGED", carrier: CARRIER,
      appointmentStatus: row.appointment_status, file: OUT,
      pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex") }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
