"use strict";

const { Client } = require("pg");

const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const SKUS = ["S158", "S159", "S160", "S161", "S162", "S163", "S164", "S165", "S166", "S566"];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin read only");
    const account = await db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
    const warehouse = await db.query("select id,code,name,is_active from fulfillment_locations where id=1");
    const catalog = await db.query(
      `select sku,description,tracking_level,uom_label,unit_uom,units_per_case,blocked,item_type
         from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
      [ACCOUNT, SKUS],
    );
    const inventory = await db.query(
      `select i.sku,fl.code warehouse_code,coalesce(sum(i.quantity),0)::integer on_hand
         from inventory_lines i left join bin_locations b on b.code=i.location
         left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
        where i.account_name=$1 and i.sku=any($2::text[])
        group by i.sku,fl.code order by i.sku,fl.code`,
      [ACCOUNT, SKUS],
    );
    const inbounds = await db.query(
      `select i.id,i.inbound_code,i.status,i.reference_number,i.expected_date::text,i.received_at::text,
              fl.code warehouse_code,count(l.id)::integer line_count,
              coalesce(sum(l.received_quantity),0)::integer received_quantity
         from portal_inbounds i join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         left join portal_inbound_lines l on l.inbound_id=i.id
        where i.account_name=$1 and (
          upper(coalesce(i.reference_number,'')) like '%PO000007%'
          or upper(coalesce(i.notes,'')) like '%PO000007%'
          or upper(coalesce(i.notes,'')) like '%ONEU0356410%'
          or exists (select 1 from portal_inbound_lines x where x.inbound_id=i.id and x.sku=any($2::text[]))
        )
        group by i.id,i.inbound_code,i.status,i.reference_number,i.expected_date,i.received_at,fl.code
        order by i.received_at,i.id`,
      [ACCOUNT, SKUS],
    );
    const inboundLines = await db.query(
      `select i.inbound_code,i.reference_number,l.line_number,l.sku,l.expected_quantity,l.received_quantity,l.received_location
         from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
        where i.account_name=$1 and l.sku=any($2::text[])
        order by i.id,l.line_number`,
      [ACCOUNT, SKUS],
    );
    const ledger = await db.query(
      `select coalesce(pi.inbound_code,t.source_id) source,t.source_type,
              min(t.server_timestamp)::text first_transaction,
              count(*)::integer line_count,sum(t.quantity_delta)::integer quantity_delta
         from inventory_transactions t
         left join portal_inbounds pi on t.source_type='PORTAL_INBOUND' and pi.id::text=t.source_id
        where t.account_name=$1 and t.sku=any($2::text[]) and t.quantity_delta>0
        group by coalesce(pi.inbound_code,t.source_id),t.source_type order by first_transaction`,
      [ACCOUNT, SKUS],
    );
    console.log(JSON.stringify({ account: account.rows, warehouse: warehouse.rows, catalog: catalog.rows,
      inventory: inventory.rows, inbounds: inbounds.rows, inboundLines: inboundLines.rows, ledger: ledger.rows }));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
