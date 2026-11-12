const { Client } = require('pg');

const ORDER_CODE = 'ORD-001395';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const REQUESTED_DATE = '2026-10-19';

async function main() {
  const apply = process.argv.includes('--apply');
  const client = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    await client.query('begin');
    if (!apply) await client.query('set transaction read only');
    const result = await client.query(`select o.id,o.order_code,o.account_name,o.fulfillment_location_id,
      fl.code warehouse_code,o.status,o.shipped_at,o.po_number,o.shipping_reference,
      o.requested_ship_date::text,o.routing_requested_delivery_date::text
      from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1 ${apply ? 'for update of o' : ''}`, [ORDER_CODE]);
    if (result.rowCount !== 1) throw new Error('Order identity is not unique.');
    const order = result.rows[0];
    if (order.account_name !== ACCOUNT || String(order.fulfillment_location_id) !== WAREHOUSE_ID
        || order.warehouse_code !== 'WHS01' || order.shipped_at || !['DRAFT', 'RELEASED', 'PICKED', 'STAGED'].includes(order.status)) {
      throw new Error('Live order identity or state changed.');
    }
    const before = order.requested_ship_date ? String(order.requested_ship_date).slice(0, 10) : null;
    if (apply && before !== REQUESTED_DATE) {
      await client.query(`update portal_orders set requested_ship_date=$2::date,updated_at=now()
        where id=$1`, [order.id, REQUESTED_DATE]);
    }
    if (apply) await client.query('commit');
    else await client.query('rollback');

    const verify = await client.query(`select order_code,account_name,fulfillment_location_id,status,
      shipped_at,requested_ship_date::text from portal_orders where id=$1`, [order.id]);
    const checked = verify.rows[0];
    const after = checked.requested_ship_date ? String(checked.requested_ship_date).slice(0, 10) : null;
    if (checked.order_code !== ORDER_CODE || checked.account_name !== ACCOUNT
        || String(checked.fulfillment_location_id) !== WAREHOUSE_ID || checked.shipped_at
        || (apply && after !== REQUESTED_DATE)) {
      throw new Error('Requested delivery date readback failed.');
    }
    console.log(JSON.stringify({ order: ORDER_CODE, account: ACCOUNT, status: checked.status,
      before, requestedDeliveryDate: apply ? after : REQUESTED_DATE, applied: apply,
      alreadyCorrect: before === REQUESTED_DATE }));
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { main };
