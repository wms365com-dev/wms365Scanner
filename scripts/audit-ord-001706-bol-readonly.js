"use strict";

const { Client } = require("pg");
const { getPortalOrderById } = require("../server");

const CODE = "ORD-001706";

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const found = await db.query(
      `select o.id, o.order_code, o.account_name, o.status, o.po_number,
              o.fulfillment_location_id, fl.code warehouse_code, fl.name warehouse_name,
              o.requested_ship_date::text, o.routing_requested_delivery_date::text,
              o.shipped_at, o.shipped_carrier_name, o.routing_total_weight,
              o.routing_weight_uom, o.outbound_total_pallets, o.picked_pallet_details,
              o.ship_to_name, o.ship_to_address1, o.ship_to_address2, o.ship_to_city,
              o.ship_to_state, o.ship_to_postal_code, o.ship_to_country
         from portal_orders o
         join fulfillment_locations fl on fl.id = o.fulfillment_location_id
        where o.order_code = $1`,
      [CODE]
    );
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    const order = await getPortalOrderById(db, row.id, row.account_name);
    const routing = await db.query(
      `select id, status, appointment_date::text, window_start::text, window_end::text
         from order_routing_requests
        where order_id = $1
        order by id desc`,
      [row.id]
    );
    const allocations = await db.query(
      `select a.id, a.sku, a.lot_number, a.location, a.allocated_quantity,
              i.quantity inventory_quantity, i.tracking_level
         from portal_order_allocations a
         join inventory_lines i on i.id = a.inventory_line_id
        where a.order_id = $1
        order by a.id`,
      [row.id]
    );
    console.log(JSON.stringify({
      order: row,
      shipTo: order.shipTo || order.shippingAddress || null,
      lines: order.lines,
      warehouseShipments: order.warehouseShipments,
      routing: routing.rows,
      allocations: allocations.rows,
    }));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
