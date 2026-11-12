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
  preparePortalOrderBillOfLading,
  reallocatePortalOrderToActualPalletLocations,
  safeDeductInventoryLineQuantity,
  upsertInventoryLine,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001591";
const ACCOUNT = "ALCONA TRADING LTD";
const WAREHOUSE_ID = "143";
const SKU = "MS26062403";
const CARRIER = "Bison";
const DELIVERY_DATE = "2026-10-22";
const DELIVERY_TIME = "10:00";
const OLD_LOCATION = "DJ30AC";
const NEW_LOCATION = "DJ34AC";
const PALLETS = [
  { palletNumber: 1, location: "DJ36AA", weight: 1046.89, weightUom: "KG" },
  { palletNumber: 2, location: "DJ30AA", weight: 1045.98, weightUom: "KG" },
  { palletNumber: 3, location: "DJ36AC", weight: 1051.43, weightUom: "KG" },
  { palletNumber: 4, location: NEW_LOCATION, weight: 1051.43, weightUom: "KG" },
];
const TOTAL_KG = 4195.73;
const FILE = `WMS365_BOL_${CODE}_2026-10-22_10AM_REVISED.pdf`;
const OUT = path.resolve(__dirname, "..", "outputs", "ord-001591-bol", FILE);
const ACTOR = { id: null, email: "prathab@greywolf3pl.com", full_name: "Owner-confirmed BOL correction", role: APP_USER_ROLES.SUPER_ADMIN };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-bol-revision-1`]);
    const found = await db.query(`select o.* from portal_orders o where o.order_code=$1 ${APPLY ? "for update" : ""}`, [CODE]);
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID || row.status !== "STAGED" || row.shipped_at
      || row.po_number !== "529673" || row.shipped_carrier_name !== "Polar North Freight Lines") throw new Error("Order scope or staged state changed.");
    let order = await getPortalOrderById(db, row.id, ACCOUNT);
    const current = order.pickedPalletDetails || [];
    const expected = ["DJ36AA", "DJ30AA", "DJ36AC", OLD_LOCATION];
    if (current.length !== 4 || current.some((p, i) => p.location !== expected[i])) throw new Error("Current pallet details do not match the prior reviewed BOL.");
    const allocation = await db.query(`select a.*,i.account_name,i.quantity,i.upc,i.expiration_date,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 and upper(a.location)=$2 ${APPLY ? "for update of a,i" : ""}`, [row.id, OLD_LOCATION]);
    if (allocation.rowCount !== 1 || allocation.rows[0].account_name !== ACCOUNT || allocation.rows[0].sku !== SKU
      || Number(allocation.rows[0].allocated_quantity) !== 1 || Number(allocation.rows[0].quantity) < 1) throw new Error("Pallet 4 allocation is not safe to revise.");
    const bin = await db.query("select code,is_pickable,fulfillment_location_id from bin_locations where upper(code)=$1", [NEW_LOCATION]);
    if (bin.rowCount !== 1 || !bin.rows[0].is_pickable || (bin.rows[0].fulfillment_location_id && String(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID)) throw new Error("DJ34AC is not an available pickable bin for this warehouse.");
    const target = await db.query("select id,quantity from inventory_lines where account_name=$1 and sku=$2 and upper(location)=$3", [ACCOUNT, SKU, NEW_LOCATION]);
    if (target.rowCount) throw new Error("DJ34AC already contains matching inventory and requires manual review.");
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, status: "STAGED", carrierFrom: row.shipped_carrier_name, carrierTo: CARRIER, locationFrom: OLD_LOCATION, locationTo: NEW_LOCATION, deliveryDate: DELIVERY_DATE, deliveryTime: "10:00 AM ET", totalWeightKg: TOTAL_KG }));
      return;
    }
    const a = allocation.rows[0];
    await upsertInventoryLine(db, { accountName: ACCOUNT, location: NEW_LOCATION, sku: SKU, upc: a.upc || "", lotNumber: a.lot_number || "",
      expirationDate: a.expiration_date || "", trackingLevel: a.tracking_level || "PALLET", quantity: 1 }, { transactionType: "MOVE_LOCATION",
      sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION", sourceId: row.id, fulfillmentLocationId: row.fulfillment_location_id,
      appUser: ACTOR, source: "web_admin", idempotencyKey: `${CODE}-${OLD_LOCATION}-to-${NEW_LOCATION}-revision1` });
    await reallocatePortalOrderToActualPalletLocations(db, order, PALLETS, ACTOR);
    await safeDeductInventoryLineQuantity(db, a.inventory_line_id, 1, { actionLabel: `correct pallet 4 from ${OLD_LOCATION} to ${NEW_LOCATION}`,
      transactionType: "MOVE_LOCATION", sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION", sourceId: row.id,
      fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: "web_admin",
      idempotencyKey: `${CODE}-${OLD_LOCATION}-to-${NEW_LOCATION}-revision1` });
    const note = `Revised BOL: carrier ${CARRIER}; pallet 4 location corrected to ${NEW_LOCATION}. Delivery appointment October 22, 2026 at 10:00 AM ET. Individual pallet weights: ${PALLETS.map(p => `${p.location} ${p.weight.toFixed(2)} kg`).join("; ")}.`;
    await db.query(`update portal_orders set picked_pallet_details=$2::jsonb,shipped_carrier_name=$3,routing_total_weight=$4,
      routing_weight_uom='KG',routing_requested_delivery_date=$5::date,order_notes=concat_ws(E'\n',nullif(trim(order_notes),''),$6::text),updated_at=now() where id=$1`,
      [row.id, JSON.stringify(PALLETS), CARRIER, TOTAL_KG, DELIVERY_DATE, note]);
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    await preparePortalOrderBillOfLading(db, order, order, { shipments: [{ shipmentId: order.warehouseShipments[0].id,
      shipmentMethod: "LTL_FREIGHT", carrier: CARRIER, totalPallets: 4, totalWeight: TOTAL_KG, weightUom: "KG",
      deliveryDate: DELIVERY_DATE, bolReference: `BOL-${CODE}-REV1` }] }, ACTOR);
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = { ...order, orderNotes: note, routingAppointment: { status: "CONFIRMED", appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME }, pickedPalletDetails: PALLETS };
    const ready = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!ready.ready) throw new Error(`Revised BOL not ready: ${ready.missingFields.join(", ")}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    await db.query(`insert into portal_order_documents(order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
      values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`, [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name, order.warehouseShipments[0].id]);
    const verify = await db.query(`select o.status,o.shipped_at,o.shipped_carrier_name,o.picked_pallet_details,s.status shipment_status,s.carrier_name,
      r.appointment_date::text,r.window_start from portal_orders o join warehouse_shipments s on s.order_id=o.id
      join order_routing_requests r on r.order_id=o.id and r.status='CONFIRMED' where o.id=$1`, [row.id]);
    const v = verify.rows[0], finalPallets = v.picked_pallet_details || [];
    if (v.status !== "STAGED" || v.shipment_status !== "STAGED" || v.shipped_at || v.shipped_carrier_name !== CARRIER || v.carrier_name !== CARRIER
      || finalPallets.length !== 4 || finalPallets.some((p, i) => p.location !== PALLETS[i].location)
      || String(v.appointment_date).slice(0, 10) !== DELIVERY_DATE || String(v.window_start).slice(0, 5) !== DELIVERY_TIME) throw new Error("Post-correction verification failed.");
    await db.query("commit");
    fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, pdf.content);
    console.log(JSON.stringify({ mode: "APPLIED", order: CODE, status: "STAGED", shipped: false, carrier: CARRIER, pallets: PALLETS,
      totalWeightKg: TOTAL_KG, file: OUT, pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex") }));
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; }
  finally { db.release(); await pool.end(); }
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
