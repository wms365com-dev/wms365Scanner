"use strict";

const { Pool } = require("pg");
const { getPortalOrderById } = require("../server");

const CODE = "ORD-001592";
const ACCOUNT = "ALCONA TRADING LTD";
const LOCATIONS = ["DJ32AC", "DJ30AC", "DJ28AC", "DJ26AC"];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin read only");
    const found = await db.query(`select id,order_code,account_name,status,fulfillment_location_id,po_number,
      shipping_reference,requested_ship_date::text,shipped_at,shipped_carrier_name,routing_total_weight,
      routing_weight_uom,routing_requested_delivery_date::text,picked_pallet_details,order_notes
      from portal_orders where order_code=$1`, [CODE]);
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT) throw new Error("Order does not belong to exact Alcona account.");
    const order = await getPortalOrderById(db, row.id, ACCOUNT);
    const allocations = await db.query(`select a.id,a.order_line_id,a.inventory_line_id,a.sku,a.location,a.lot_number,
      a.allocated_quantity,i.quantity inventory_quantity,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id`, [row.id]);
    const routing = await db.query(`select id,status,appointment_date::text,window_start,window_end,recipient_email,
      responder_name,responder_note from order_routing_requests where order_id=$1 order by id desc`, [row.id]);
    const shipments = await db.query(`select id,status,account_name,fulfillment_location_id,carrier_name,total_pallets,
      total_weight,weight_uom,delivery_date::text from warehouse_shipments where order_id=$1 order by id`, [row.id]);
    const docs = await db.query(`select id,file_name,document_category,file_size from portal_order_documents
      where order_id=$1 order by id`, [row.id]);
    const bins = await db.query(`select code,is_pickable,fulfillment_location_id from bin_locations
      where upper(replace(code,'-',''))=any($1::text[]) order by code`, [LOCATIONS]);
    console.log(JSON.stringify({
      row,
      lines: order.lines.map((line) => ({ id: line.id, sku: line.sku, quantity: line.quantity, allocatedQuantity: line.allocatedQuantity })),
      allocations: allocations.rows,
      shipments: shipments.rows,
      routing: routing.rows,
      documents: docs.rows,
      requestedBins: bins.rows,
    }, null, 2));
    await db.query("rollback");
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
