const { Client } = require('pg');

const ACCOUNT = 'ZETA GROUP (CANADA) LTD.';
const SKU = 'S001W';
const UPC = '19421905946190';

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    await client.query('begin read only');
    const account = await client.query('select id,name,is_active from owner_accounts where name=$1', [ACCOUNT]);
    const existing = await client.query(`select account_name,sku,description,upc,tracking_level,unit_uom,
      uom_label,units_per_case,lot_tracked,expiration_tracked,blocked,item_type,item_category
      from item_catalog where (account_name=$1 and (sku=$2 or regexp_replace(upc,'\\.0$','')=$3))
      or sku=$2 or regexp_replace(upc,'\\.0$','')=$3 order by account_name,sku`, [ACCOUNT, SKU, UPC]);
    const peers = await client.query(`select sku,description,upc,tracking_level,unit_uom,uom_label,
      units_per_case,lot_tracked,expiration_tracked,blocked,item_type,item_category
      from item_catalog where account_name=$1 order by sku limit 100`, [ACCOUNT]);
    const warehouse = await client.query(`select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_outbound,cfl.allow_storage
      from fulfillment_locations fl join company_fulfillment_locations cfl
        on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
      where fl.id=1`, [ACCOUNT]);
    await client.query('rollback');
    console.log(JSON.stringify({ account: account.rows, existing: existing.rows, peers: peers.rows,
      warehouse: warehouse.rows }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { main };
