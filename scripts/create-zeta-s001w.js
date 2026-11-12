const { Client } = require('pg');

const ACCOUNT = 'ZETA GROUP (CANADA) LTD.';
const ACCOUNT_ID = '1566';
const SKU = 'S001W';
const DESCRIPTION = 'Terra Water Travel Pack 24s x10 FSC 100% Bamboo SGSHK-COC-011958';
const UPC = '19421905946190';
const UNITS_PER_CASE = 10;

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.env.RAILWAY_PROJECT_ID !== '3f4e7e7e-7eda-4275-8dd0-2c1c3f869698'
      || process.env.RAILWAY_ENVIRONMENT_ID !== 'e1f5b77e-b935-4f41-9cc5-fccb28edbc57'
      || process.env.RAILWAY_SERVICE_ID !== '2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0') {
    throw new Error('WMS365 production target mismatch');
  }
  const client = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  let committed = false;
  try {
    await client.query('begin');
    if (!apply) await client.query('set transaction read only');
    if (apply) await client.query('select pg_advisory_xact_lock(hashtext($1))', [`item:${ACCOUNT}:${SKU}`]);

    const account = await client.query('select id,is_active from owner_accounts where name=$1', [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error('Zeta account identity mismatch');
    }
    const warehouse = await client.query(`select fl.id,fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage
      from fulfillment_locations fl join company_fulfillment_locations cfl
        on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=1`, [ACCOUNT]);
    if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== 'GW3PL-MISS'
        || !warehouse.rows[0].is_active || !warehouse.rows[0].allow_outbound || !warehouse.rows[0].allow_storage) {
      throw new Error('Zeta Mississauga warehouse assignment mismatch');
    }
    const barcode = await client.query(`select account_name,sku from item_catalog
      where regexp_replace(upc,'\\.0$','')=$1 and not (account_name=$2 and sku=$3)`, [UPC, ACCOUNT, SKU]);
    if (barcode.rowCount) throw new Error('UPC already belongs to another catalog item.');
    const existing = await client.query(`select account_name,sku,description,upc,tracking_level,unit_uom,
      uom_label,units_per_case,lot_tracked,expiration_tracked,blocked,item_type,item_category
      from item_catalog where account_name=$1 and sku=$2 ${apply ? 'for update' : ''}`, [ACCOUNT, SKU]);
    let outcome = 'would_create';
    if (existing.rowCount) {
      const item = existing.rows[0];
      if (item.description !== DESCRIPTION || String(item.upc).replace(/\.0$/, '') !== UPC
          || item.tracking_level !== 'CASE' || Number(item.units_per_case) !== UNITS_PER_CASE
          || item.lot_tracked || item.expiration_tracked || item.blocked || item.item_type !== 'INVENTORY') {
        throw new Error('Existing Zeta SKU conflicts with the requested item.');
      }
      outcome = 'already_exists';
    } else if (apply) {
      await client.query(`insert into item_catalog
        (account_name,sku,description,upc,tracking_level,unit_uom,uom_label,units_per_case,
         lot_tracked,expiration_tracked,blocked,item_type,item_category)
        values($1,$2,$3,$4,'CASE','','',$5,false,false,false,'INVENTORY','')`,
      [ACCOUNT, SKU, DESCRIPTION, UPC, UNITS_PER_CASE]);
      outcome = 'created';
    }
    if (apply) {
      await client.query('commit');
      committed = true;
    } else {
      await client.query('rollback');
    }

    const readback = apply ? await client.query(`select account_name,sku,description,upc,tracking_level,
      unit_uom,uom_label,units_per_case,lot_tracked,expiration_tracked,blocked,item_type,item_category
      from item_catalog where account_name=$1 and sku=$2`, [ACCOUNT, SKU]) : null;
    const item = readback?.rows[0] || {
      account_name: ACCOUNT, sku: SKU, description: DESCRIPTION, upc: UPC,
      tracking_level: 'CASE', unit_uom: '', uom_label: '', units_per_case: UNITS_PER_CASE,
      lot_tracked: false, expiration_tracked: false, blocked: false, item_type: 'INVENTORY', item_category: '',
    };
    if (apply && (readback.rowCount !== 1 || item.description !== DESCRIPTION
        || String(item.upc).replace(/\.0$/, '') !== UPC || item.tracking_level !== 'CASE'
        || Number(item.units_per_case) !== UNITS_PER_CASE || item.lot_tracked
        || item.expiration_tracked || item.blocked || item.item_type !== 'INVENTORY')) {
      throw new Error('Created item failed readback verification.');
    }
    console.log(JSON.stringify({ outcome, applied: apply, warehouse: 'GW3PL-MISS', item }));
  } catch (error) {
    if (!committed) await client.query('rollback').catch(() => {});
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
