"use strict";

const { Client } = require("pg");
const ACCOUNT = "NOMMM CANADA INC.";
const INTEGRATION_ID = 6;
const SHOPIFY_SKUS = ["1000", "NOMMM-FOUNDER-GIFT-3PK", "NOMMM-BYE-8X40"];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query("begin read only");
    const mappings = await client.query(`select id,external_sku,local_sku,local_quantity_multiplier,note from store_sku_mappings where integration_id=$1 and account_name=$2 order by external_sku`, [INTEGRATION_ID, ACCOUNT]);
    const catalog = await client.query(`select sku,description,upc,tracking_level,units_per_case from item_catalog where account_name=$1 order by sku`, [ACCOUNT]);
    const inventory = await client.query(`select sku,sum(quantity)::int on_hand,array_agg(distinct location order by location) locations from inventory_lines where account_name=$1 group by sku order by sku`, [ACCOUNT]);
    const orderLines = await client.query(`select distinct l.sku from portal_order_lines l join portal_orders o on o.id=l.order_id where o.account_name=$1 order by l.sku`, [ACCOUNT]);
    const localSkus = new Set(catalog.rows.map((row) => row.sku));
    console.log(JSON.stringify({
      mappings: mappings.rows,
      catalogSkus: catalog.rows,
      inventorySkus: inventory.rows,
      orderLineSkus: orderLines.rows.map((row) => row.sku),
      exactMatches: SHOPIFY_SKUS.filter((sku) => localSkus.has(sku)),
      unmatched: SHOPIFY_SKUS.filter((sku) => !localSkus.has(sku))
    }, null, 2));
    await client.query("rollback");
  } finally { await client.end(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
