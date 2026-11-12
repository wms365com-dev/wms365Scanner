"use strict";

const { withTransaction } = require("../server");

async function main() {
  const result = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const found = await client.query(
      `select o.id, o.order_code, o.account_name, o.status, o.po_number,
              o.shipping_reference, o.shipment_method, o.confirmed_ship_date::text,
              o.shipped_at, o.shipped_carrier_name, o.shipped_tracking_reference,
              o.shipment_email_status, o.fulfillment_location_id,
              o.outbound_total_pallets, o.routing_total_weight, o.routing_weight_uom,
              fl.code warehouse_code, fl.name warehouse_name
         from portal_orders o
         join fulfillment_locations fl on fl.id = o.fulfillment_location_id
        where o.order_code = 'ORD-001782'`
    );
    if (found.rowCount !== 1) throw new Error("Expected one exact ORD-001782.");
    const order = found.rows[0];
    const lines = (await client.query(
      `select l.id, l.sku, l.requested_quantity,
              coalesce(sum(a.allocated_quantity), 0)::integer allocated_quantity
         from portal_order_lines l
         left join portal_order_allocations a on a.order_line_id = l.id
        where l.order_id = $1
        group by l.id, l.sku, l.requested_quantity
        order by l.id`,
      [order.id]
    )).rows;
    const shipments = (await client.query(
      `select id, status, carrier_name, tracking_reference, bol_reference,
              total_pallets, total_weight, weight_uom, shipped_at
         from warehouse_shipments where order_id = $1 order by id`,
      [order.id]
    )).rows;
    const documents = (await client.query(
      "select id, file_name, document_category from portal_order_documents where order_id = $1 order by id",
      [order.id]
    )).rows;
    const preferences = (await client.query(
      `select email, notification_type, is_subscribed
         from customer_email_preferences
        where account_name = $1 and notification_type = 'SHIPMENT_CONFIRMATION'
        order by email`,
      [order.account_name]
    )).rows;
    return { order, lines, shipments, documents, preferences };
  });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
