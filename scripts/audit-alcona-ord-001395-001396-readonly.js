const { Client } = require('pg');
const zlib = require('node:zlib');

const CODES = ['ORD-001395', 'ORD-001396'];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const orders = (await db.query(`select o.*,fl.code warehouse_code,fl.name warehouse_name
      from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=any($1::text[]) order by o.order_code`, [CODES])).rows;
    if (orders.length !== 2) throw new Error(`Expected two orders; found ${orders.length}`);
    const ids = orders.map(o => o.id);
    const lines = (await db.query(`select l.* from portal_order_lines l where l.order_id=any($1::bigint[]) order by l.order_id,l.id`, [ids])).rows;
    const allocations = (await db.query(`select a.*,i.quantity inventory_quantity,i.account_name inventory_account,
      i.tracking_level,i.upc,i.expiration_date from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=any($1::bigint[]) order by a.order_id,a.id`, [ids])).rows;
    const shipments = (await db.query(`select * from warehouse_shipments where order_id=any($1::bigint[]) order by order_id,id`, [ids])).rows;
    const shipmentLines = (await db.query(`select sl.* from warehouse_shipment_lines sl join warehouse_shipments s on s.id=sl.shipment_id
      where s.order_id=any($1::bigint[]) order by s.order_id,sl.id`, [ids])).rows;
    const ledger = (await db.query(`select * from inventory_transactions where source_id=any($1::text[])
      order by server_timestamp,id`, [ids.map(String)])).rows;
    const docs = (await db.query(`select id,order_id,file_name,file_type,file_size,document_category,created_at
      from portal_order_documents where order_id=any($1::bigint[]) order by order_id,id`, [ids])).rows;
    const billing = (await db.query(`select * from billing_events where source_ref=any($1::text[]) order by id`, [CODES])).rows;
    const emails = (await db.query(`select id,status,source_ref,delivery_key,subject,sent_at,to_addresses,cc_addresses,bcc_addresses
      from email_delivery_log where source_ref=any($1::text[]) order by id`, [CODES])).rows;
    await db.query('rollback');
    const result = { generatedAt: new Date().toISOString(), orders, lines, allocations, shipments, shipmentLines, ledger, docs, billing, emails };
    process.stdout.write('DATA:' + zlib.gzipSync(Buffer.from(JSON.stringify(result))).toString('base64') + '\n');
  } finally { await db.end(); }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
