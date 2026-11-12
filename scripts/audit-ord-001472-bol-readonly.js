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
             o.requested_ship_date::text, o.shipment_method, o.shipped_at,
             o.outbound_total_pallets, o.routing_total_weight, o.routing_weight_uom,
             o.routing_requested_delivery_date::text, o.shipped_carrier_name,
             o.picked_pallet_details, o.order_notes
      from portal_orders o
      join fulfillment_locations fl on fl.id = o.fulfillment_location_id
      where o.order_code = $1
    `, ['ORD-001472']);
    if (orderResult.rowCount !== 1) throw new Error('Order identity is not unique.');
    const order = orderResult.rows[0];
    const lines = await client.query(`
      select l.id, l.sku, l.requested_quantity,
             coalesce(sum(a.allocated_quantity), 0)::integer as allocated_quantity
      from portal_order_lines l
      left join portal_order_allocations a on a.order_line_id = l.id
      where l.order_id = $1
      group by l.id order by l.id
    `, [order.id]);
    const shipments = await client.query(`
      select id, status, shipment_method, carrier_name, total_pallets,
             total_weight, weight_uom, delivery_date::text, bol_reference
      from warehouse_shipments where order_id = $1 order by id
    `, [order.id]);
    const documents = await client.query(`
      select id, file_name, document_category, created_at
      from portal_order_documents where order_id = $1 order by id
    `, [order.id]);
    await client.query('rollback');
    console.log(JSON.stringify({ order, lines: lines.rows, shipments: shipments.rows, documents: documents.rows }, null, 2));
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
