"use strict";

const { Client } = require("pg");
const INBOUND_CODE = process.argv[2] || "INB-000234";

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin read only");
    const inbound = (await db.query(
      `select i.id,i.inbound_code,i.account_name,i.status,i.reference_number,i.carrier_name,
              i.expected_date::text,i.received_at::text,fl.code warehouse_code
         from portal_inbounds i join fulfillment_locations fl on fl.id=i.fulfillment_location_id
        where i.inbound_code=$1`, [INBOUND_CODE],
    )).rows[0];
    if (!inbound) throw new Error(`${INBOUND_CODE} was not found.`);
    const lineSummary = (await db.query(
      `select count(*)::integer line_count,sum(expected_quantity)::integer expected_quantity,
              sum(received_quantity)::integer received_quantity,sum(coalesce(pallet_count,0))::integer pallets,
              count(*) filter (where received_location='GW3PL-MISS-ZETA-BULK')::integer correct_location_lines
         from portal_inbound_lines where inbound_id=$1`, [inbound.id],
    )).rows[0];
    const ledger = (await db.query(
      `select count(*)::integer line_count,sum(quantity_delta)::integer quantity_delta,
              count(distinct sku)::integer sku_count,min(server_timestamp)::text posted_at
         from inventory_transactions
        where source_type='PORTAL_INBOUND' and source_id=$1::text and account_name=$2`,
      [inbound.id, inbound.account_name],
    )).rows[0];
    const exceptions = (await db.query(
      `select l.sku,l.expected_quantity,l.received_quantity,l.received_location,
              coalesce(sum(t.quantity_delta),0)::integer ledger_quantity
         from portal_inbound_lines l
         left join inventory_transactions t on t.source_type='PORTAL_INBOUND'
          and t.source_id=l.inbound_id::text and t.sku=l.sku and t.account_name=$2
        where l.inbound_id=$1
        group by l.id,l.sku,l.expected_quantity,l.received_quantity,l.received_location
       having l.expected_quantity<>l.received_quantity
           or l.received_location<>'GW3PL-MISS-ZETA-BULK'
           or l.received_quantity<>coalesce(sum(t.quantity_delta),0)`,
      [inbound.id, inbound.account_name],
    )).rows;
    console.log(JSON.stringify({ inbound, lineSummary, ledger, exceptions }));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
