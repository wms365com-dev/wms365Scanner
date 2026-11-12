"use strict";

const { Client } = require("pg");

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const order = await db.query(
      `select o.id, o.order_code, o.account_name, o.status, o.shipped_at,
              o.fulfillment_location_id, fl.code warehouse_code, o.po_number,
              o.shipped_carrier_name, o.shipped_tracking_reference,
              o.outbound_total_pallets, o.routing_total_weight, o.routing_weight_uom,
              o.requested_ship_date::text, o.routing_requested_delivery_date::text
         from portal_orders o
         join fulfillment_locations fl on fl.id = o.fulfillment_location_id
        where o.order_code = $1`,
      ["ORD-001794"]
    );
    if (order.rowCount !== 1) throw new Error("ORD-001794 identity is not unique.");
    const id = order.rows[0].id;
    const [lines, allocations, confirmations, shipments, documents, billing, movements] = await Promise.all([
      db.query(
        `select l.id, l.sku, l.requested_quantity,
                coalesce(sum(a.allocated_quantity), 0)::integer allocated_quantity
           from portal_order_lines l
           left join portal_order_allocations a on a.order_line_id = l.id
          where l.order_id = $1
          group by l.id, l.sku, l.requested_quantity order by l.id`,
        [id]
      ),
      db.query(
        `select a.order_line_id, a.sku, a.location, a.allocated_quantity,
                i.id inventory_line_id, i.quantity inventory_quantity,
                i.account_name inventory_account
           from portal_order_allocations a
           join inventory_lines i on i.id = a.inventory_line_id
          where a.order_id = $1 order by a.id`,
        [id]
      ),
      db.query(
        `select line_id, coalesce(sum(quantity), 0)::integer confirmed_quantity
           from pick_confirmations
          where order_id = $1 and sync_status <> 'FAILED'
          group by line_id order by line_id`,
        [id]
      ),
      db.query(
        `select id, status, shipment_method, carrier_name, tracking_reference,
                bol_reference, total_pallets, total_weight, weight_uom,
                delivery_date::text, shipped_at
           from warehouse_shipments where order_id = $1 order by id`,
        [id]
      ),
      db.query(
        `select id, file_name, file_type, document_category, file_size, created_at
           from portal_order_documents where order_id = $1 order by id`,
        [id]
      ),
      db.query(
        `select id, billing_code, quantity, status, idempotency_key
           from billing_events where source_type = 'PORTAL_ORDER' and source_id = $1 order by id`,
        [String(id)]
      ).catch(() => ({ rows: [] })),
      db.query(
        `select id, transaction_type, sku, quantity, reference_type, reference_id
           from inventory_transactions where reference_id = $1 order by id`,
        [String(id)]
      ).catch(() => ({ rows: [] })),
    ]);
    await db.query("rollback");
    console.log(JSON.stringify({
      order: order.rows[0],
      lines: lines.rows,
      allocations: allocations.rows,
      pickConfirmations: confirmations.rows,
      shipments: shipments.rows,
      documents: documents.rows,
      existingBillingEvents: billing.rows,
      existingInventoryTransactions: movements.rows,
    }, null, 2));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
