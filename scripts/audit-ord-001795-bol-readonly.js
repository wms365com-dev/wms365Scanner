"use strict";

const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    max: 1,
  });
  const db = await pool.connect();
  try {
    await db.query("begin read only");
    const result = await db.query(
      `select o.id, o.order_code, o.account_name, o.status, o.shipped_at,
              o.po_number, o.requested_ship_date::text,
              o.routing_requested_delivery_date::text,
              o.outbound_total_pallets, o.routing_total_weight,
              o.routing_weight_uom, o.shipped_carrier_name,
              fl.id fulfillment_location_id, fl.code warehouse_code,
              s.id shipment_id, s.status shipment_status,
              s.shipment_method, s.carrier_name, s.bol_reference,
              s.total_pallets, s.total_weight, s.weight_uom,
              s.delivery_date::text,
              coalesce(json_agg(json_build_object(
                'id', d.id, 'fileName', d.file_name,
                'category', d.document_category, 'bytes', d.file_size
              )) filter (where d.id is not null), '[]') documents
         from portal_orders o
         join fulfillment_locations fl on fl.id = o.fulfillment_location_id
         left join warehouse_shipments s on s.order_id = o.id
         left join portal_order_documents d on d.order_id = o.id
        where o.order_code = 'ORD-001795'
        group by o.id, fl.id, fl.code, s.id`,
    );
    if (result.rowCount !== 1) throw new Error("Order or shipment identity is not unique.");
    console.log(JSON.stringify(result.rows[0]));
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
