"use strict";

const { Client } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const CONTAINER = "BEAU6285382";
const SKUS = ["WHOOPSIE-SMPL", "WW-12PK"];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("begin read only");
    const account = (await db.query(
      "select id, name, is_active from owner_accounts where name = $1",
      [ACCOUNT]
    )).rows;
    const locations = (await db.query(
      `select cfl.fulfillment_location_id, cfl.is_primary, cfl.allow_inbound,
              fl.code, fl.name, fl.address1, fl.city, fl.state, fl.postal_code
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
        where cfl.account_name = $1 order by cfl.is_primary desc, fl.id`,
      [ACCOUNT]
    )).rows;
    const items = (await db.query(
      `select account_name, sku, description, tracking_level, units_per_case,
              lot_tracked, expiration_tracked
         from item_catalog where account_name = $1 and sku = any($2::text[]) order by sku`,
      [ACCOUNT, SKUS]
    )).rows;
    const duplicate = (await db.query(
      `select i.id, i.inbound_code, i.status, i.reference_number, i.notes,
              i.expected_date::text, i.received_at, fl.code warehouse_code
         from portal_inbounds i
         left join fulfillment_locations fl on fl.id = i.fulfillment_location_id
        where upper(trim(i.reference_number)) = upper($1)
           or upper(i.notes) like '%' || upper($1) || '%'
        order by i.id`,
      [CONTAINER]
    )).rows;
    const history = (await db.query(
      `select i.inbound_code, i.status, i.reference_number, i.notes,
              i.expected_date::text, i.received_at, fl.code warehouse_code,
              l.sku, l.expected_quantity, l.received_quantity, l.received_location
         from portal_inbounds i
         join portal_inbound_lines l on l.inbound_id = i.id
         left join fulfillment_locations fl on fl.id = i.fulfillment_location_id
        where i.account_name = $1 and l.sku = any($2::text[])
        order by i.id desc, l.id desc limit 30`,
      [ACCOUNT, SKUS]
    )).rows;
    const inventory = (await db.query(
      `select sku, location, sum(quantity)::integer quantity
         from inventory_lines
        where account_name = $1 and sku = any($2::text[])
        group by sku, location order by sku, location`,
      [ACCOUNT, SKUS]
    )).rows;
    const ledger = duplicate.length === 1 ? (await db.query(
      `select sku, sum(quantity_delta)::integer quantity_delta
         from inventory_transactions
        where source_type = 'PORTAL_INBOUND' and source_id = $1
        group by sku order by sku`,
      [String(duplicate[0].id)]
    )).rows : [];
    console.log(JSON.stringify({ account, locations, items, duplicate, history, inventory, ledger }));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
