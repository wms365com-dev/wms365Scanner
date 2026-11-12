"use strict";
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { APP_USER_ROLES, buildPortalOrderBillOfLadingPdfAttachment, getPortalOrderBillOfLadingReadiness,
  getPortalOrderById, preparePortalOrderBillOfLading, safeDeductInventoryLineQuantity,
  updateAdminPortalOrderStatus, upsertInventoryLine } = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001698", ACCOUNT = "ALCONA TRADING LTD", PO = "529673", WAREHOUSE_ID = "143";
const SKU = "MS26062403", LOT = "MS26062403", CARRIER = "Bison";
const DELIVERY_DATE = "2026-10-27", DELIVERY_TIME = "11:00";
const SOURCES = ["DI40AA", "DI40AB", "DI40AC", "DI42AA"];
const PALLETS = [
  ["DJ24AC", 2321], ["DJ22AC", 2320], ["DJ20AC", 2320], ["DJ18AC", 2318]
].map(([location, pounds], index) => ({ palletNumber: index + 1, from: SOURCES[index], location,
  weight: Number((pounds * 0.45359237).toFixed(2)), weightUom: "KG", sourceWeightLb: pounds }));
const TOTAL_KG = Number(PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0).toFixed(2));
const FILE = `WMS365_BOL_${CODE}_2026-10-27_11AM.pdf`;
const ACTOR = { id: null, email: "prathab@greywolf3pl.com", full_name: "Owner-confirmed pallet picks and BOL",
  role: APP_USER_ROLES.SUPER_ADMIN };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-stage-bol`]);
    const found = await db.query(`select o.*,fl.code warehouse_code from portal_orders o
      join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1 ${APPLY ? "for update of o" : ""}`, [CODE]);
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || row.po_number !== PO || String(row.fulfillment_location_id) !== WAREHOUSE_ID
      || row.status !== "RELEASED" || row.shipped_at || String(row.shipped_carrier_name || ""))
      throw new Error("Order identity, state, or carrier changed.");
    let order = await getPortalOrderById(db, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== SKU || Number(order.lines[0].quantity) !== 4
      || Number(order.lines[0].allocatedQuantity) !== 4 || order.warehouseShipments.length !== 1
      || order.warehouseShipments[0].status !== "RELEASED") throw new Error("Order line, allocation, or shipment changed.");
    const allocations = await db.query(`select a.*,i.account_name,i.quantity,i.upc,i.expiration_date,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id ${APPLY ? "for update of a,i" : ""}`, [row.id]);
    if (allocations.rowCount !== 4 || allocations.rows.some((a, i) => a.location !== SOURCES[i] || a.sku !== SKU
      || a.lot_number !== LOT || Number(a.allocated_quantity) !== 1 || Number(a.quantity) !== 1
      || a.account_name !== ACCOUNT || a.tracking_level !== "PALLET")) throw new Error("Source pallet allocations changed.");
    const bins = await db.query(`select code,is_pickable,fulfillment_location_id from bin_locations
      where upper(replace(code,'-',''))=any($1::text[])`, [PALLETS.map((p) => p.location)]);
    if (bins.rowCount !== 4 || bins.rows.some((bin) => !bin.is_pickable
      || (bin.fulfillment_location_id && String(bin.fulfillment_location_id) !== WAREHOUSE_ID)))
      throw new Error("One or more physical target bins are unavailable.");
    const occupied = await db.query(`select location from inventory_lines where account_name=$1 and sku=$2
      and upper(location)=any($3::text[])`, [ACCOUNT, SKU, PALLETS.map((p) => p.location)]);
    if (occupied.rowCount) throw new Error("A target bin already contains this SKU and requires review.");
    const routing = await db.query(`select id,status from order_routing_requests where order_id=$1 order by id desc
      ${APPLY ? "for update" : ""}`, [row.id]);
    if (routing.rowCount !== 1 || routing.rows[0].status !== "PENDING") throw new Error("Routing request state changed.");
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, po: PO, status: row.status, carrier: CARRIER,
        deliveryDate: DELIVERY_DATE, deliveryTime: "11:00 AM ET", pallets: PALLETS, totalWeightKg: TOTAL_KG }));
      return;
    }
    for (let i = 0; i < PALLETS.length; i += 1) {
      const pallet = PALLETS[i], allocation = allocations.rows[i];
      await upsertInventoryLine(db, { accountName: ACCOUNT, location: pallet.location, sku: SKU, upc: allocation.upc || "",
        lotNumber: LOT, expirationDate: allocation.expiration_date || "", trackingLevel: "PALLET", quantity: 1 },
      { transactionType: "MOVE_LOCATION", sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION", sourceId: row.id,
        fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: "web_admin",
        idempotencyKey: `${CODE}-${pallet.from}-to-${pallet.location}` });
    }
    await updateAdminPortalOrderStatus(db, row.id, "PICKING", { idempotencyKey: `${CODE}-picking` }, ACTOR);
    await updateAdminPortalOrderStatus(db, row.id, "PICKED", { idempotencyKey: `${CODE}-picked`,
      pickedPalletDetails: PALLETS.map(({ palletNumber, location, weight, weightUom }) => ({ palletNumber, location, weight, weightUom })) }, ACTOR);
    for (let i = 0; i < PALLETS.length; i += 1) await safeDeductInventoryLineQuantity(db, allocations.rows[i].inventory_line_id, 1,
      { actionLabel: `record physical pallet move ${PALLETS[i].from} to ${PALLETS[i].location}`,
        transactionType: "MOVE_LOCATION", sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION", sourceId: row.id,
        fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: "web_admin",
        idempotencyKey: `${CODE}-${PALLETS[i].from}-to-${PALLETS[i].location}` });
    await updateAdminPortalOrderStatus(db, row.id, "STAGED", { idempotencyKey: `${CODE}-staged` }, ACTOR);
    const note = `Carrier Bison. Delivery requested October 27, 2026 at 11:00 AM ET. Physical pallets: ${PALLETS.map((p) => `${p.location} ${p.weight.toFixed(2)} kg`).join("; ")}. Total ${TOTAL_KG.toFixed(2)} kg.`;
    await db.query(`update portal_orders set order_notes=$2,shipped_carrier_name=$3,routing_total_weight=$4,
      routing_weight_uom='KG',routing_requested_delivery_date=$5::date,requested_ship_date=$5::date,
      outbound_total_pallets=4,outbound_existing_pallets=4,outbound_new_pallets=0,outbound_mixed_pallets=0,updated_at=now()
      where id=$1`, [row.id, `${row.order_notes || ""}\n${note}`.trim(), CARRIER, TOTAL_KG, DELIVERY_DATE]);
    await db.query(`update order_routing_requests set appointment_date=$2::date,window_start=$3::time,window_end=null,
      responder_note='Owner requested delivery October 27, 2026 at 11:00 AM ET; receiver confirmation remains pending.',updated_at=now()
      where id=$1`, [routing.rows[0].id, DELIVERY_DATE, DELIVERY_TIME]);
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    await preparePortalOrderBillOfLading(db, order, order, { shipments: [{ shipmentId: order.warehouseShipments[0].id,
      shipmentMethod: "LTL_FREIGHT", carrier: CARRIER, totalPallets: 4, existingPallets: 4, newPallets: 0,
      mixedPallets: 0, totalWeight: TOTAL_KG, weightUom: "KG", deliveryDate: DELIVERY_DATE,
      bolReference: `BOL-${CODE}` }] }, ACTOR);
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = { ...order, orderNotes: `${note} PRE-SHIPMENT / UNSIGNED.`,
      routingAppointment: { status: "PENDING", appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME },
      pickedPalletDetails: PALLETS.map(({ palletNumber, location, weight, weightUom }) => ({ palletNumber, location, weight, weightUom })) };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Invalid BOL PDF.");
    const duplicate = await db.query(`select id from portal_order_documents where order_id=$1 and file_name=$2`, [row.id, FILE]);
    if (duplicate.rowCount) throw new Error("A BOL with this reviewed filename already exists.");
    await db.query(`insert into portal_order_documents(order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
      values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`, [row.id, FILE, pdf.content.length, pdf.content,
      ACTOR.full_name, order.warehouseShipments[0].id]);
    const verify = await db.query(`select o.status,o.shipped_at,o.shipped_carrier_name,o.routing_total_weight,o.routing_weight_uom,
      o.picked_pallet_details,s.status shipment_status,s.carrier_name,s.total_pallets,s.total_weight,s.weight_uom,s.delivery_date::text
      from portal_orders o join warehouse_shipments s on s.order_id=o.id where o.id=$1`, [row.id]);
    const final = verify.rows[0];
    if (final.status !== "STAGED" || final.shipped_at || final.shipment_status !== "STAGED" || final.shipped_carrier_name !== CARRIER
      || final.carrier_name !== CARRIER || Number(final.total_pallets) !== 4 || Number(final.routing_total_weight) !== TOTAL_KG
      || Number(final.total_weight) !== TOTAL_KG || final.routing_weight_uom !== "KG" || final.weight_uom !== "KG"
      || String(final.delivery_date).slice(0, 10) !== DELIVERY_DATE) throw new Error("Post-prepare verification failed.");
    await db.query("commit");
    console.log(JSON.stringify({ mode: "APPLIED", order: CODE, status: "STAGED", carrier: CARRIER,
      deliveryDate: DELIVERY_DATE, deliveryTime: "11:00 AM ET", appointmentStatus: "PENDING", pallets: PALLETS,
      totalWeightKg: TOTAL_KG, fileName: FILE, documentBytes: pdf.content.length,
      pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex"), shipped: false, emailsSent: 0 }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally { db.release(); await pool.end(); }
}
module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
