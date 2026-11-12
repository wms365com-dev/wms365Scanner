const { Client } = require("pg");

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const items = await db.query(`
      select account_name, sku, description, upc, unit_uom, units_per_case, blocked
      from item_catalog
      where upper(sku) = 'S164'
      order by account_name
    `);
    const inventory = await db.query(`
      select i.account_name, i.sku, i.location, i.lot_number, i.expiration_date,
             i.quantity,
             coalesce((select sum(a.allocated_quantity)
                       from portal_order_allocations a
                       join portal_orders o on o.id = a.order_id
                       where a.inventory_line_id = i.id
                         and o.status not in ('SHIPPED','CANCELLED')), 0) allocated_quantity
      from inventory_lines i
      where upper(i.sku) = 'S164' and i.quantity <> 0
      order by i.account_name, i.location, i.lot_number
    `);
    const warehouses = await db.query(`
      select id, code, name, address1, city, state, postal_code, country, is_active
      from fulfillment_locations
      where lower(coalesce(state,'')) in ('on','ontario')
         or lower(coalesce(city,'')) in ('mississauga','brampton','toronto')
      order by id
    `);
    const allocations = await db.query(`
      select o.order_code, o.status, o.ship_to_name, o.po_number,
             o.requested_ship_date, o.routing_requested_delivery_date, l.line_number, l.sku,
             a.allocated_quantity, i.location, i.lot_number
      from portal_order_allocations a
      join inventory_lines i on i.id = a.inventory_line_id
      join portal_orders o on o.id = a.order_id
      join portal_order_lines l on l.id = a.order_line_id
      where i.account_name = 'ZETA GROUP (CANADA) LTD.'
        and upper(i.sku) = 'S164'
        and o.status not in ('SHIPPED','CANCELLED')
      order by o.order_code, l.line_number, a.id
    `);
    const shipmentHistory = await db.query(`
      select o.order_code, o.ship_to_name, o.po_number,
             coalesce(o.confirmed_ship_date, (o.shipped_at at time zone 'America/Toronto')::date) ship_date,
             o.shipped_carrier_name, sum(s.shipped_quantity)::integer shipped_quantity
      from portal_orders o
      join portal_order_shipment_lines s on s.order_id = o.id
      where o.account_name = 'ZETA GROUP (CANADA) LTD.'
        and upper(s.sku) = 'S164'
        and o.status = 'SHIPPED'
        and s.shipped_quantity > 0
      group by o.id, o.order_code, o.ship_to_name, o.po_number,
               o.confirmed_ship_date, o.shipped_at, o.shipped_carrier_name
      order by ship_date, o.order_code
    `);
    console.log(JSON.stringify({ items: items.rows, inventory: inventory.rows, allocations: allocations.rows, shipmentHistory: shipmentHistory.rows, ontarioWarehouses: warehouses.rows }));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
module.exports = { main };
