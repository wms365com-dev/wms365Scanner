"use strict";
const { Pool } = require("pg");
const { getPortalOrderById } = require("../server");
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin read only");
    const found = await db.query(`select id,order_code,account_name,status,fulfillment_location_id,po_number,
      shipping_reference,requested_ship_date::text,shipped_at,order_notes from portal_orders where order_code='ORD-001591'`);
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    const order = await getPortalOrderById(db, row.id, row.account_name);
    const allocations = await db.query(`select a.id,a.order_line_id,a.inventory_line_id,a.sku,a.location,a.lot_number,
      a.allocated_quantity,i.quantity inventory_quantity
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id`, [row.id]);
    const routing = await db.query(`select status,appointment_date::text,window_start,window_end,recipient_email
      from order_routing_requests where order_id=$1 order by id desc`, [row.id]);
    const docs = await db.query(`select id,file_name,document_category,file_size from portal_order_documents
      where order_id=$1 order by id`, [row.id]);
    const physicalBins = await db.query(`select i.id,i.location,i.sku,i.lot_number,i.quantity,
      coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
        join portal_orders o on o.id=a.order_id where a.inventory_line_id=i.id
        and o.status in ('RELEASED','PICKING','PICKED','STAGED')),0)::int allocated
      from inventory_lines i where i.account_name=$1 and i.sku='MS26062403'
        and i.location=any($2::text[]) order by i.location,i.id`,
      [row.account_name,['DJ36AA','DJ30AA','DJ36AC','DJ30AC']]);
    console.log(JSON.stringify({ row, lines: order.lines.map(l => ({ id:l.id,sku:l.sku,quantity:l.quantity,allocatedQuantity:l.allocatedQuantity })),
      warehouseShipments: order.warehouseShipments.map(s => ({id:s.id,status:s.status,carrier:s.carrier,totalPallets:s.pallets?.total,totalWeight:s.totalWeight,weightUom:s.weightUom})),
      allocations: allocations.rows, physicalBins: physicalBins.rows, routing: routing.rows, documents: docs.rows }, null, 2));
    await db.query("rollback");
  } finally { db.release(); await pool.end(); }
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode=1; });
