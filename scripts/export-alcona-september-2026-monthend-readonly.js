const { Client } = require('pg');
const zlib = require('node:zlib');

const ACCOUNT = 'ALCONA TRADING LTD';
const START = '2026-09-01';
const END = '2026-10-01';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const inbound = await db.query(`select i.id,i.inbound_code,i.status,i.reference_number,i.carrier_name,
      i.expected_date,i.received_at,i.fulfillment_location_id,fl.code warehouse_code,fl.name warehouse_name
      from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
      where i.account_name=$1 and i.received_at >= ($2::date at time zone 'America/New_York')
        and i.received_at < ($3::date at time zone 'America/New_York')
        and i.status in ('RECEIVED','PUTAWAY_COMPLETE')
      order by i.received_at,i.inbound_code`, [ACCOUNT, START, END]);
    const inboundIds = inbound.rows.map(r => r.id);
    const inboundLines = inboundIds.length ? await db.query(`select l.inbound_id,l.line_number,l.sku,
      l.expected_quantity,l.received_quantity,l.received_location,l.lot_number,l.expiration_date,
      l.pallet_count,l.pallet_codes from portal_inbound_lines l where l.inbound_id=any($1::bigint[])
      order by l.inbound_id,l.line_number`, [inboundIds]) : { rows: [] };

    const outbound = await db.query(`select o.id,o.order_code,o.status,o.po_number,o.shipping_reference,
      o.ship_to_name,o.ship_to_city,o.ship_to_state,o.ship_to_country,o.shipment_method,
      o.shipped_carrier_name,o.shipped_tracking_reference,o.requested_ship_date,
      o.confirmed_ship_date,o.shipped_at,o.fulfillment_location_id,
      o.outbound_total_pallets,o.outbound_new_pallets,o.outbound_existing_pallets,
      o.outbound_mixed_pallets,o.routing_total_weight,o.routing_weight_uom,
      fl.code warehouse_code,fl.name warehouse_name
      from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.account_name=$1 and o.status='SHIPPED' and
        (o.confirmed_ship_date >= $2::date and o.confirmed_ship_date < $3::date or
         (o.shipped_at >= ($2::date at time zone 'America/New_York') and
          o.shipped_at < ($3::date at time zone 'America/New_York')))
      order by o.confirmed_ship_date,o.order_code`, [ACCOUNT, START, END]);
    const orderIds = outbound.rows.map(r => r.id);
    const outboundLines = orderIds.length ? await db.query(`select l.order_id,l.id order_line_id,
      l.line_number,l.sku,l.requested_quantity,
      coalesce(sum(sl.shipped_quantity),0)::integer shipped_quantity
      from portal_order_lines l left join warehouse_shipment_lines sl on sl.order_line_id=l.id
      where l.order_id=any($1::bigint[]) group by l.order_id,l.id,l.line_number,l.sku,l.requested_quantity
      order by l.order_id,l.line_number`, [orderIds]) : { rows: [] };
    const shipments = orderIds.length ? await db.query(`select s.order_id,s.shipment_code,s.status,
      s.carrier_name,s.tracking_reference,s.bol_reference,s.total_pallets,
      s.existing_pallets,s.new_pallets,s.mixed_pallets,s.total_weight,s.weight_uom,s.shipped_at
      from warehouse_shipments s where s.order_id=any($1::bigint[]) and s.account_name=$2
      order by s.order_id,s.id`, [orderIds, ACCOUNT]) : { rows: [] };
    const documents = orderIds.length ? await db.query(`select d.order_id,
      count(*)::integer document_count,
      count(*) filter (where d.file_name ilike '%BOL%' or d.document_category ilike '%BOL%')::integer bol_count
      from portal_order_documents d where d.order_id=any($1::bigint[]) group by d.order_id`, [orderIds]) : { rows: [] };
    const billingEvents = await db.query(`select id,event_key,fee_code,fee_category,fee_name,
      unit_label,quantity,rate,amount,currency_code,service_date,status,invoice_number,
      source_type,source_ref,activity_date,activity_type,charge_type,description,
      unit_rate,warehouse_id,created_at
      from billing_events where account_name=$1 and
        (service_date >= $2::date and service_date < $3::date or
         activity_date >= $2::date and activity_date < $3::date)
      order by coalesce(service_date,activity_date),id`, [ACCOUNT, START, END]);
    const result = {
      account: ACCOUNT, periodStart: START, periodEndExclusive: END,
      generatedAt: new Date().toISOString(), timezone: 'America/New_York',
      source: 'WMS365 Railway production / read-only repeatable-read snapshot',
      inbounds: inbound.rows, inboundLines: inboundLines.rows,
      outbounds: outbound.rows, outboundLines: outboundLines.rows,
      shipments: shipments.rows, documents: documents.rows, billingEvents: billingEvents.rows
    };
    await db.query('ROLLBACK');
    process.stdout.write('DATA:' + zlib.gzipSync(Buffer.from(JSON.stringify(result))).toString('base64') + '\n');
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await db.end(); }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
