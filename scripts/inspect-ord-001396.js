const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    await client.query('begin read only');
    const orderResult = await client.query(`
      select o.id, o.order_code, o.account_name, o.fulfillment_location_id,
             fl.code as warehouse_code, o.status, o.po_number, o.shipping_reference,
             o.requested_ship_date::text,
             o.shipped_at, o.routed_at, o.routing_email,
             o.routing_requested_delivery_date::text, o.outbound_total_pallets,
             o.routing_total_weight, o.routing_weight_uom, o.shipped_carrier_name,
             o.picked_pallet_details, o.order_notes
      from portal_orders o
      join fulfillment_locations fl on fl.id = o.fulfillment_location_id
      where o.order_code = $1
    `, ['ORD-001396']);
    if (orderResult.rowCount !== 1) throw new Error('Order identity is not unique.');
    const order = orderResult.rows[0];
    const allocations = await client.query(`
      select a.id, a.location, a.sku, a.lot_number, a.allocated_quantity,
             i.id as inventory_id, i.quantity, i.tracking_level
      from portal_order_allocations a
      join inventory_lines i on i.id = a.inventory_line_id
      where a.order_id = $1
      order by a.id
    `, [order.id]);
    const shipments = await client.query(`
      select id, status, carrier_name, total_pallets, total_weight, weight_uom,
             delivery_date::text, tracking_reference
      from warehouse_shipments where order_id = $1 order by id
    `, [order.id]);
    const routing = await client.query(`
      select id, status, appointment_date::text, window_start, window_end, recipient_email
      from order_routing_requests where order_id = $1 order by id
    `, [order.id]);
    await client.query('rollback');
    console.log(JSON.stringify({ order, allocations: allocations.rows,
      shipments: shipments.rows, routing: routing.rows }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
