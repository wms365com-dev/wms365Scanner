"use strict";

const { Client } = require("pg");

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("begin read only");
    const accounts = (await db.query(
      `select account_name, count(*)::integer transaction_count,
              min(server_timestamp) first_transaction_at,
              max(server_timestamp) last_transaction_at,
              sum(quantity_delta)::numeric net_ledger_quantity
         from inventory_transactions
        where upper(sku) = 'S598V'
        group by account_name order by account_name`
    )).rows;
    const items = (await db.query(
      `select account_name, sku, description, tracking_level, units_per_case
         from item_catalog where upper(sku) = 'S598V' order by account_name`
    )).rows;
    const stock = (await db.query(
      `select i.account_name, i.location, i.lot_number, i.expiration_date::text,
              i.tracking_level, i.quantity
         from inventory_lines i
        where upper(i.sku) = 'S598V' and i.quantity <> 0
        order by i.account_name, i.location, i.id`
    )).rows;
    const transactions = (await db.query(
      `select t.id, t.account_name,
              (t.server_timestamp at time zone 'America/New_York')::timestamp as transaction_time_et,
              t.transaction_type, t.source_type, t.source_id,
              case
                when t.source_type = 'PORTAL_ORDER' then po.order_code
                when t.source_type = 'PORTAL_INBOUND' then pi.inbound_code
                when t.source_type = 'PORTAL_KITTING_REQUEST' then pk.request_code
                else t.source_id
              end as source_reference,
              t.location, t.lot_number, t.expiration_date::text,
              t.quantity_delta, t.quantity_before, t.quantity_after,
              t.source, t.idempotency_key,
              fl.code warehouse_code, fl.name warehouse_name
         from inventory_transactions t
         left join portal_orders po on t.source_type = 'PORTAL_ORDER' and po.id::text = t.source_id
         left join portal_inbounds pi on t.source_type = 'PORTAL_INBOUND' and pi.id::text = t.source_id
         left join portal_kitting_requests pk on t.source_type = 'PORTAL_KITTING_REQUEST'
          and (pk.id::text = t.source_id or pk.request_code = t.source_id)
         left join fulfillment_locations fl on fl.id = t.fulfillment_location_id
        where upper(t.sku) = 'S598V'
        order by t.account_name, t.server_timestamp, t.id`
    )).rows;
    const totals = (await db.query(
      `select account_name, transaction_type, count(*)::integer transaction_count,
              sum(quantity_delta)::numeric net_quantity
         from inventory_transactions
        where upper(sku) = 'S598V'
        group by account_name, transaction_type
        order by account_name, transaction_type`
    )).rows;
    console.log(`REPORT_JSON:${JSON.stringify({ generatedAt: new Date().toISOString(), sku: "S598V",
      accounts, items, stock, totals, transactions })}`);
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
