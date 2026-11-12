"use strict";

const { Client } = require("pg");

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const integration = await db.query(
      `select id, account_name, provider, store_identifier, is_active,
              last_synced_at, last_sync_status, last_sync_message
         from store_integrations
        where id = 4 and account_name = $1 and provider = 'SHOPIFY'
          and store_identifier = $2 and is_active = true`,
      ["RANCHER'S CHIPS", "f1acxk-dc.myshopify.com"]
    );
    const warehouse = await db.query(
      "select id, code from fulfillment_locations where id = 1 and code = 'GW3PL-MISS'"
    );
    if (integration.rowCount !== 1 || warehouse.rowCount !== 1) {
      throw new Error("Pinned Rancher's production scope mismatch.");
    }
    await db.query("rollback");
    console.log(JSON.stringify({ integration: integration.rows[0], warehouse: warehouse.rows[0] }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
