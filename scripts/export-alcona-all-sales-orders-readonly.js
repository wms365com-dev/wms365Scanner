const { Client } = require('pg');
const zlib = require('node:zlib');

const ACCOUNT = 'ALCONA TRADING LTD';

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const account = await db.query(`
      select id, name, is_active
      from owner_accounts
      where name = $1
    `, [ACCOUNT]);
    if (account.rowCount !== 1 || account.rows[0].name !== ACCOUNT || !account.rows[0].is_active) {
      throw new Error(`Exact account identity check failed for ${ACCOUNT}`);
    }

    const orders = await db.query(`
      select o.id, o.order_code, o.status, o.po_number, o.shipping_reference,
        o.created_at, o.released_at, o.picked_at, o.staged_at, o.shipped_at,
        o.cancelled_at, o.archived_at, o.requested_ship_date, o.confirmed_ship_date,
        o.ship_to_name, o.ship_to_city, o.ship_to_state, o.ship_to_country,
        o.shipment_method, o.order_type, o.shipped_carrier_name,
        o.shipped_tracking_reference, o.outbound_total_pallets,
        o.outbound_new_pallets, o.outbound_existing_pallets, o.outbound_mixed_pallets,
        o.routing_total_weight, o.routing_weight_uom, o.order_notes,
        o.fulfillment_location_id, fl.code warehouse_code, fl.name warehouse_name
      from portal_orders o
      left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
      where o.account_name = $1
      order by o.created_at, o.order_code
    `, [ACCOUNT]);

    const orderIds = orders.rows.map((row) => row.id);
    const lines = orderIds.length ? await db.query(`
      select l.order_id, l.id order_line_id, l.line_number, l.sku,
        l.requested_quantity,
        coalesce(sum(sl.shipped_quantity), 0)::numeric shipped_quantity
      from portal_order_lines l
      left join warehouse_shipment_lines sl on sl.order_line_id = l.id
      where l.order_id = any($1::bigint[])
      group by l.order_id, l.id, l.line_number, l.sku, l.requested_quantity
      order by l.order_id, l.line_number
    `, [orderIds]) : { rows: [] };

    const shipments = orderIds.length ? await db.query(`
      select s.order_id, s.shipment_code, s.status, s.carrier_name,
        s.tracking_reference, s.bol_reference, s.total_pallets,
        s.existing_pallets, s.new_pallets, s.mixed_pallets,
        s.total_weight, s.weight_uom, s.shipped_at, s.created_at
      from warehouse_shipments s
      where s.order_id = any($1::bigint[]) and s.account_name = $2
      order by s.order_id, s.id
    `, [orderIds, ACCOUNT]) : { rows: [] };

    const documents = orderIds.length ? await db.query(`
      select d.order_id, count(*)::integer document_count,
        count(*) filter (where d.file_name ilike '%BOL%' or d.document_category ilike '%BOL%')::integer bol_count
      from portal_order_documents d
      where d.order_id = any($1::bigint[])
      group by d.order_id
    `, [orderIds]) : { rows: [] };

    const result = {
      account: account.rows[0],
      generatedAt: new Date().toISOString(),
      timezone: 'America/New_York',
      source: 'WMS365 Railway production / read-only repeatable-read snapshot',
      orders: orders.rows,
      lines: lines.rows,
      shipments: shipments.rows,
      documents: documents.rows,
    };
    await db.query('ROLLBACK');
    process.stdout.write(`DATA:${zlib.gzipSync(Buffer.from(JSON.stringify(result))).toString('base64')}\n`);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
