const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const result = await client.query(`
      select o.order_code,o.po_number,o.status,o.shipment_method,o.shipped_tracking_reference,
             array_agg(l.sku||':'||l.requested_quantity order by l.line_number) as lines
      from portal_orders o join portal_order_lines l on l.order_id=o.id
      where o.account_name='WELLFORIA HEALTH INC' and o.po_number like 'WF-CONS-20261013-%'
      group by o.id order by o.id
    `);
    console.log(JSON.stringify(result.rows));
  } finally {
    await client.end();
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
