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
const CODE = "ORD-001706";
const ACCOUNT = "ALCONA TRADING LTD";
const PO = "529673";
const WAREHOUSE_ID = "143";
const SKU = "MS26062403";
const LOT = "MS26062403";
const CARRIER = "Bison";
const DELIVERY_DATE = "2026-10-29";
const DELIVERY_TIME = "11:00";
const PALLETS = [
  { palletNumber: 1, location: "DI42AB", weight: 1053.24, weightUom: "KG" },
  { palletNumber: 2, location: "DI42AC", weight: 1052.33, weightUom: "KG" },
  { palletNumber: 3, location: "DI44AA", weight: 1054.60, weightUom: "KG" },
  { palletNumber: 4, location: "DI44AB", weight: 1052.33, weightUom: "KG" },
];
const TOTAL_KG = Number(PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0).toFixed(2));
const FILE = `WMS365_BOL_${CODE}_2026-10-29_11AM.pdf`;
const ACTOR = {
  id: null,
  email: "prathab@greywolf3pl.com",
  full_name: "Owner-confirmed staged pallets and BOL preview",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    max: 1,
  });
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-prepare-bol`]);
    const found = await db.query(
      `select o.*, fl.code warehouse_code
         from portal_orders o
         join fulfillment_locations fl on fl.id = o.fulfillment_location_id
        where o.order_code = $1 ${APPLY ? "for update of o" : ""}`,
      [CODE]
    );
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || row.po_number !== PO
      || String(row.fulfillment_location_id) !== WAREHOUSE_ID
      || row.status !== "STAGED" || row.shipped_at
      || String(row.ship_to_name || "").trim().toUpperCase() !== "NUTEM CUSTOM MANUFACTURING"
      || String(row.ship_to_address1 || "").trim().toUpperCase() !== "1105 CLAY AVE"
      || String(row.ship_to_postal_code || "").replace(/\s/g, "").toUpperCase() !== "L7L0A1") {
      throw new Error("Order identity, destination, or state changed.");
    }
    let order = await getPortalOrderById(db, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== SKU
      || Number(order.lines[0].quantity) !== 4 || Number(order.lines[0].allocatedQuantity) !== 4
      || order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== "STAGED") {
      throw new Error("Order line, allocation, or shipment state changed.");
    }
    const allocations = await db.query(
      `select a.location, a.sku, a.lot_number, a.allocated_quantity,
              i.account_name, i.quantity, i.tracking_level
         from portal_order_allocations a
         join inventory_lines i on i.id = a.inventory_line_id
        where a.order_id = $1
        order by a.id ${APPLY ? "for update of a, i" : ""}`,
      [row.id]
    );
    if (allocations.rowCount !== 4 || allocations.rows.some((allocation, index) => (
      allocation.location !== PALLETS[index].location
      || allocation.sku !== SKU || allocation.lot_number !== LOT
      || Number(allocation.allocated_quantity) !== 1 || Number(allocation.quantity) !== 1
      || allocation.account_name !== ACCOUNT || allocation.tracking_level !== "PALLET"
    ))) throw new Error("Allocated pallet identities changed.");
    const routing = await db.query(
      `select id, status from order_routing_requests
        where order_id = $1 order by id desc ${APPLY ? "for update" : ""}`,
      [row.id]
    );
    if (routing.rowCount !== 1 || !["PENDING", "CONFIRMED"].includes(routing.rows[0].status)) {
      throw new Error("Routing request state changed.");
    }
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, po: PO, status: row.status,
        carrier: CARRIER, deliveryDate: DELIVERY_DATE, deliveryTime: "11:00 AM ET",
        appointmentStatus: routing.rows[0].status, pallets: PALLETS, totalWeightKg: TOTAL_KG }));
      return;
    }

    const note = `Carrier Bison. Delivery appointment October 29, 2026 at 11:00 AM ET. `
      + `Staged pallets: ${PALLETS.map((pallet) => `${pallet.location} ${pallet.weight.toFixed(2)} kg`).join("; ")}. `
      + `Total ${TOTAL_KG.toFixed(2)} kg. PRE-SHIPMENT / UNSIGNED.`;
    await db.query(
      `update portal_orders
          set shipped_carrier_name = $2, picked_pallet_details = $3::jsonb,
              routing_total_weight = $4, routing_weight_uom = 'KG',
              routing_requested_delivery_date = $5::date, requested_ship_date = $5::date,
              outbound_total_pallets = 4, outbound_existing_pallets = 4,
              outbound_new_pallets = 0, outbound_mixed_pallets = 0, updated_at = now()
        where id = $1`,
      [row.id, CARRIER, JSON.stringify(PALLETS), TOTAL_KG, DELIVERY_DATE]
    );
    await db.query(
      `update warehouse_shipments
          set shipment_method = 'LTL_FREIGHT', carrier_name = $2,
              bol_reference = $3, total_pallets = 4, existing_pallets = 4,
              new_pallets = 0, mixed_pallets = 0, total_weight = $4,
              weight_uom = 'KG', delivery_date = $5::date, updated_at = now()
        where order_id = $1`,
      [row.id, CARRIER, `BOL-${CODE}`, TOTAL_KG, DELIVERY_DATE]
    );
    await db.query(
      `update order_routing_requests
          set appointment_date = $2::date, window_start = $3::time, window_end = null,
              responder_note = 'Owner confirmed delivery appointment October 29, 2026 at 11:00 AM ET.',
              updated_at = now()
        where id = $1`,
      [routing.rows[0].id, DELIVERY_DATE, DELIVERY_TIME]
    );
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = {
      ...order,
      orderNotes: note,
      pickedPalletDetails: PALLETS,
      routingTotalWeight: TOTAL_KG,
      routingWeightUom: "KG",
      routingAppointment: {
        status: "CONFIRMED",
        appointmentDate: DELIVERY_DATE,
        windowStart: DELIVERY_TIME,
        displayWindow: "11:00 AM ET",
      },
      warehouseShipments: order.warehouseShipments.map((shipment) => ({
        ...shipment,
        status: "STAGED",
        shipmentMethod: "LTL_FREIGHT",
        carrier: CARRIER,
        bolReference: `BOL-${CODE}`,
        pallets: { total: 4, existing: 4, new: 0, mixed: 0 },
        totalWeight: TOTAL_KG,
        weightUom: "KG",
        deliveryDate: DELIVERY_DATE,
      })),
    };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Invalid BOL PDF.");
    const existing = await db.query(
      "select id, file_data from portal_order_documents where order_id = $1 and file_name = $2",
      [row.id, FILE]
    );
    if (existing.rowCount > 1) throw new Error("Existing BOL identity is not unique.");
    if (existing.rowCount === 1) {
      await db.query(
        `update portal_order_documents set file_size = $3, file_data = $4, uploaded_by = $5
          where order_id = $1 and file_name = $2`,
        [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name]
      );
    } else {
      await db.query(
        `insert into portal_order_documents
          (order_id, file_name, file_type, file_size, file_data, document_category, uploaded_by, warehouse_shipment_id)
         values ($1, $2, 'application/pdf', $3, $4, 'SHIPMENT_BOL', $5, $6)`,
        [row.id, FILE, pdf.content.length, pdf.content, ACTOR.full_name, order.warehouseShipments[0].id]
      );
    }
    const verify = await db.query(
      `select o.status, o.shipped_at, o.shipped_carrier_name, o.routing_total_weight,
              o.routing_weight_uom, s.status shipment_status, s.carrier_name,
              s.total_pallets, s.total_weight, s.weight_uom, s.delivery_date::text
         from portal_orders o
         join warehouse_shipments s on s.order_id = o.id
        where o.id = $1`,
      [row.id]
    );
    const final = verify.rows[0];
    if (final.status !== "STAGED" || final.shipped_at || final.shipment_status !== "STAGED"
      || final.shipped_carrier_name !== CARRIER || final.carrier_name !== CARRIER
      || Number(final.total_pallets) !== 4 || Number(final.routing_total_weight) !== TOTAL_KG
      || Number(final.total_weight) !== TOTAL_KG || final.routing_weight_uom !== "KG"
      || final.weight_uom !== "KG" || String(final.delivery_date).slice(0, 10) !== DELIVERY_DATE) {
      throw new Error("Post-prepare verification failed.");
    }
    await db.query("commit");
    console.log(JSON.stringify({ mode: "APPLIED", order: CODE, status: "STAGED", carrier: CARRIER,
      deliveryDate: DELIVERY_DATE, deliveryTime: "11:00 AM ET", pallets: PALLETS,
      totalWeightKg: TOTAL_KG, fileName: FILE, documentBytes: pdf.content.length,
      pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex"),
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
if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
