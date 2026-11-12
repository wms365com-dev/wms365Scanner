"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
  APP_USER_ROLES,
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
  reallocatePortalOrderToActualPalletLocations,
  safeDeductInventoryLineQuantity,
  updateAdminPortalOrderStatus,
  upsertInventoryLine,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-002095";
const ACCOUNT = "ALCONA TRADING LTD";
const PO = "529674";
const WAREHOUSE_ID = "143";
const WAREHOUSE_CODE = "WHS01";
const SKU = "MS26062403";
const LOT = "MS26062403";
const CARRIER = "Bison";
const DELIVERY_DATE = "2026-11-02";
const DELIVERY_TIME = "15:30";
const PALLETS = [
  ["DJ08AA", 2311],
  ["DJ08AB", 2310],
  ["", 2309],
  ["DJ06AB", 2309],
].map(([location, pounds], index) => ({
  palletNumber: index + 1,
  location,
  weight: Number((pounds * 0.45359237).toFixed(2)),
  weightUom: "KG",
  sourceWeightLb: pounds,
}));
const PICK_PALLETS = PALLETS.map((pallet, index) => ({
  ...pallet,
  location: pallet.location || (index === 2 ? "WHS01-REC" : pallet.location),
}));
const TOTAL_KG = Number(PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0).toFixed(2));
const FILE = `WMS365_BOL_${CODE}_2026-11-02_330PM.pdf`;
const ACTOR = {
  id: null,
  email: "prathab@greywolf3pl.com",
  full_name: "Owner-confirmed pallet weights and BOL",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    max: 1,
  });
  const db = await pool.connect();
  let committed = false;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-prepare-bol`]);
    const found = await db.query(
      `select o.*, fl.code warehouse_code
         from portal_orders o
         join fulfillment_locations fl on fl.id = o.fulfillment_location_id
        where o.order_code = $1
        for update of o`,
      [CODE]
    );
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || row.po_number !== PO
      || String(row.fulfillment_location_id) !== WAREHOUSE_ID
      || row.warehouse_code !== WAREHOUSE_CODE || row.status !== "PICKING"
      || row.shipped_at || String(row.shipped_carrier_name || "").trim()
      || String(row.ship_to_name || "").trim().toUpperCase() !== "NUTEM CUSTOM MANUFACTURING"
      || String(row.ship_to_address1 || "").trim().toUpperCase() !== "1105 CLAY AVE"
      || String(row.ship_to_postal_code || "").replace(/\s/g, "").toUpperCase() !== "L7L0A1") {
      throw new Error("Order identity, destination, warehouse, or state changed.");
    }

    let order = await getPortalOrderById(db, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== SKU
      || Number(order.lines[0].quantity) !== 4
      || Number(order.lines[0].allocatedQuantity) !== 4
      || order.warehouseShipments.length !== 1
      || order.warehouseShipments[0].status !== "PICKING") {
      throw new Error("Order line, allocation, or shipment state changed.");
    }
    const sourceAllocations = await db.query(
      `select a.*, i.quantity inventory_quantity, i.account_name,
              i.tracking_level inventory_tracking_level, i.upc, i.expiration_date
         from portal_order_allocations a
         join inventory_lines i on i.id = a.inventory_line_id
        where a.order_id = $1
        order by a.id
        for update of a, i`,
      [row.id]
    );
    if (sourceAllocations.rowCount !== 1 || sourceAllocations.rows[0].sku !== SKU
      || sourceAllocations.rows[0].lot_number !== LOT
      || Number(sourceAllocations.rows[0].allocated_quantity) !== 4
      || Number(sourceAllocations.rows[0].inventory_quantity) < 4
      || sourceAllocations.rows[0].account_name !== ACCOUNT
      || sourceAllocations.rows[0].inventory_tracking_level !== "PALLET") {
      throw new Error("Order allocation identity changed.");
    }
    const sourceAllocation = sourceAllocations.rows[0];
    const bins = await db.query(
      `select code, is_pickable, location_type, account_name, fulfillment_location_id
         from bin_locations
        where upper(replace(code, '-', '')) = any($1::text[])
        order by code`,
      [PICK_PALLETS.map((pallet) => pallet.location.replace(/-/g, ""))]
    );
    if (bins.rowCount !== 4 || bins.rows.some((bin) => (
      !bin.is_pickable || bin.location_type !== "STORAGE"
      || (String(bin.account_name || "").trim() && bin.account_name !== ACCOUNT)
      || (bin.fulfillment_location_id && String(bin.fulfillment_location_id) !== WAREHOUSE_ID)
    ))) throw new Error("One or more physical pallet bins conflict with the order warehouse.");
    await db.query(
      `update bin_locations
          set account_name = $1, fulfillment_location_id = $2, updated_at = now()
        where upper(code) = 'DJ08AB'
          and coalesce(account_name, '') = ''
          and fulfillment_location_id is null`,
      [ACCOUNT, Number(WAREHOUSE_ID)]
    );
    const targetInventory = await db.query(
      `select id, location, quantity
         from inventory_lines
        where account_name = $1 and sku = $2
          and upper(location) = any($3::text[])
        order by location
        for update`,
      [ACCOUNT, SKU, PICK_PALLETS.map((pallet) => pallet.location)]
    );
    const byLocation = new Map(targetInventory.rows.map((item) => [
      String(item.location).toUpperCase(), item,
    ]));
    for (const pallet of PICK_PALLETS) {
      const item = byLocation.get(pallet.location);
      if (item && Number(item.quantity) < 1) {
        throw new Error(`Physical pallet bin ${pallet.location} has no available inventory.`);
      }
    }
    if (!byLocation.has("DJ08AB")) {
      await upsertInventoryLine(db, {
        accountName: ACCOUNT,
        location: "DJ08AB",
        sku: SKU,
        upc: sourceAllocation.upc || "",
        lotNumber: LOT,
        expirationDate: sourceAllocation.expiration_date || "",
        trackingLevel: "PALLET",
        quantity: 1,
      }, {
        transactionType: "MOVE_LOCATION",
        sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION",
        sourceId: row.id,
        fulfillmentLocationId: row.fulfillment_location_id,
        appUser: ACTOR,
        source: "web_admin",
        idempotencyKey: `${CODE}-WHS01-REC-to-DJ08AB-in`,
      });
      await safeDeductInventoryLineQuantity(db, sourceAllocation.inventory_line_id, 1, {
        actionLabel: "record physical pallet move WHS01-REC to DJ08AB",
        transactionType: "MOVE_LOCATION",
        sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION",
        sourceId: row.id,
        fulfillmentLocationId: row.fulfillment_location_id,
        appUser: ACTOR,
        source: "web_admin",
        idempotencyKey: `${CODE}-WHS01-REC-to-DJ08AB-out`,
      });
    }
    await db.query(
      "update portal_order_allocations set allocated_quantity = 1, updated_at = now() where id = $1",
      [sourceAllocation.id]
    );
    for (let index = 0; index < 3; index += 1) {
      await db.query(
        `insert into portal_order_allocations
          (order_id, order_line_id, inventory_line_id, sku, location, lot_number,
           expiration_date, tracking_level, allocated_quantity, is_oversell, oversell_policy_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,1,false,null)`,
        [sourceAllocation.order_id, sourceAllocation.order_line_id,
          sourceAllocation.inventory_line_id, sourceAllocation.sku,
          sourceAllocation.location, sourceAllocation.lot_number,
          sourceAllocation.expiration_date, sourceAllocation.tracking_level]
      );
    }
    order = await getPortalOrderById(db, row.id, ACCOUNT);
    await reallocatePortalOrderToActualPalletLocations(db, order, PICK_PALLETS, ACTOR);
    order = await updateAdminPortalOrderStatus(db, row.id, "PICKED", {
      idempotencyKey: `${CODE}-picked`,
      pickedPalletDetails: PICK_PALLETS.map(({ palletNumber, location, weight, weightUom }) => ({
        palletNumber, location, weight, weightUom,
      })),
    }, ACTOR);
    order = await updateAdminPortalOrderStatus(db, row.id, "STAGED", {
      idempotencyKey: `${CODE}-staged`,
    }, ACTOR);

    const existing = await db.query(
      `select id, file_data
         from portal_order_documents
        where order_id = $1 and file_name = $2 and document_category = 'SHIPMENT_BOL'`,
      [row.id, FILE]
    );
    if (existing.rowCount > 1) throw new Error("Existing BOL identity is not unique.");

    const note = `Carrier ${CARRIER}. Delivery confirmed November 2, 2026 at 3:30 PM ET. `
      + `Physical pallets: ${PALLETS.map((pallet) => `${pallet.location} ${pallet.weight.toFixed(2)} kg`).join("; ")}. `
      + `Total ${TOTAL_KG.toFixed(2)} kg. PRE-SHIPMENT / UNSIGNED.`;
    await db.query(
      `update portal_orders
          set order_notes = $2, shipped_carrier_name = $3,
              picked_pallet_details = $4::jsonb,
              routing_total_weight = $5, routing_weight_uom = 'KG',
              routing_requested_delivery_date = $6::date,
              requested_ship_date = $6::date,
              outbound_total_pallets = 4, outbound_existing_pallets = 4,
              outbound_new_pallets = 0, outbound_mixed_pallets = 0,
              updated_at = now()
        where id = $1`,
      [row.id, `${row.order_notes || ""}\n${note}`.trim(), CARRIER,
        JSON.stringify(PALLETS.map(({ palletNumber, location, weight, weightUom }) => ({
          palletNumber, location, weight, weightUom,
        }))), TOTAL_KG, DELIVERY_DATE]
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

    order = await getPortalOrderById(db, row.id, ACCOUNT);
    const bolOrder = {
      ...order,
      orderNotes: note,
      pickedPalletDetails: PALLETS.map(({ palletNumber, location, weight, weightUom }) => ({
        palletNumber, location, weight, weightUom,
      })),
      routingTotalWeight: TOTAL_KG,
      routingWeightUom: "KG",
      routingAppointment: {
        status: "CONFIRMED",
        appointmentDate: DELIVERY_DATE,
        windowStart: DELIVERY_TIME,
        displayWindow: "3:30 PM ET",
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
    if (existing.rowCount === 1) {
      await db.query(
        `update portal_order_documents
            set file_size = $3, file_data = $4, uploaded_by = $5
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
      `select o.status, o.shipped_at, o.shipped_carrier_name,
              o.routing_total_weight, o.routing_weight_uom,
              s.status shipment_status, s.carrier_name, s.total_pallets,
              s.total_weight, s.weight_uom, s.delivery_date::text,
              (select count(*) from portal_order_documents d
                where d.order_id = o.id and d.file_name = $2
                  and d.document_category = 'SHIPMENT_BOL')::integer bol_count
         from portal_orders o
         join warehouse_shipments s on s.order_id = o.id
        where o.id = $1`,
      [row.id, FILE]
    );
    const final = verify.rows[0];
    if (final.status !== "STAGED" || final.shipped_at
      || final.shipment_status !== "STAGED"
      || final.shipped_carrier_name !== CARRIER || final.carrier_name !== CARRIER
      || Number(final.total_pallets) !== 4
      || Number(final.routing_total_weight) !== TOTAL_KG
      || Number(final.total_weight) !== TOTAL_KG
      || final.routing_weight_uom !== "KG" || final.weight_uom !== "KG"
      || String(final.delivery_date).slice(0, 10) !== DELIVERY_DATE
      || Number(final.bol_count) !== 1) {
      throw new Error("Post-prepare verification failed.");
    }
    const result = {
      mode: APPLY ? "APPLIED" : "PREFLIGHT_ROLLED_BACK",
      order: CODE,
      status: "STAGED",
      carrier: CARRIER,
      deliveryDate: DELIVERY_DATE,
      deliveryTime: "3:30 PM ET",
      appointmentStatus: "CONFIRMED",
      pallets: PALLETS,
      totalWeightKg: TOTAL_KG,
      fileName: FILE,
      documentBytes: pdf.content.length,
      pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex"),
      shipped: false,
      emailsSent: 0,
    };
    if (APPLY) {
      await db.query("commit");
      committed = true;
    } else {
      await db.query("rollback");
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    if (!committed) await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

module.exports = { main };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
