const { Client } = require('pg');

const CODES = ['ORD-00548', 'ORD-000548'];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const orders = (await db.query(`select o.id,o.order_code,o.account_name,o.status,o.shipped_at,
      o.fulfillment_location_id,fl.code warehouse_code,fl.name warehouse_name
      from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=any($1::text[]) order by o.order_code`, [CODES])).rows;
    const ids = orders.map((row) => row.id);
    const shipments = ids.length ? (await db.query(`select s.id,s.order_id,s.shipment_code,s.status,
      s.fulfillment_location_id,fl.code warehouse_code,fl.name warehouse_name,s.shipped_at
      from warehouse_shipments s left join fulfillment_locations fl on fl.id=s.fulfillment_location_id
      where s.order_id=any($1::bigint[]) order by s.id`, [ids])).rows : [];
    const shipmentIds = shipments.map((row) => row.id);
    const shipmentLines = shipmentIds.length ? (await db.query(`select sl.shipment_id,sl.order_line_id,
      sl.sku,sl.ordered_quantity,sl.shipped_quantity from warehouse_shipment_lines sl
      where sl.shipment_id=any($1::bigint[]) order by sl.shipment_id,sl.id`, [shipmentIds])).rows : [];
    const orderLines = ids.length ? (await db.query(`select l.id,l.order_id,l.line_number,l.sku,
      l.requested_quantity from portal_order_lines l
      where l.order_id=any($1::bigint[]) order by l.id`, [ids])).rows : [];
    const docs = ids.length ? (await db.query(`select d.id,d.order_id,d.warehouse_shipment_id,d.file_name,
      d.file_type,d.file_size,d.document_category,d.created_at
      from portal_order_documents d where d.order_id=any($1::bigint[])
      order by d.created_at,d.id`, [ids])).rows : [];
    await db.query('rollback');
    console.log(JSON.stringify({ orders, orderLines, shipments, shipmentLines, documents: docs }));
  } finally {
    await db.end();
  }
}

module.exports = { main };
