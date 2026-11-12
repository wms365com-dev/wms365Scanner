const { Client } = require('pg');

const ACCOUNT = 'ZETA GROUP (CANADA) LTD.';
const SKU = 'S624F';
const DESCRIPTION = 'Terra Facial Cleansing Towel 20x6';
const UPC = '19421908626341';

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== '3f4e7e7e-7eda-4275-8dd0-2c1c3f869698'
        || process.env.RAILWAY_ENVIRONMENT_ID !== 'e1f5b77e-b935-4f41-9cc5-fccb28edbc57'
        || process.env.RAILWAY_SERVICE_ID !== '2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0') {
        throw new Error('WMS365 production target mismatch');
    }
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let committed = false;
    try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`item:${ACCOUNT}:${SKU}`]);
        const account = await client.query('select id,is_active from owner_accounts where name=$1', [ACCOUNT]);
        if (account.rowCount !== 1 || String(account.rows[0].id) !== '1566' || !account.rows[0].is_active) {
            throw new Error('Zeta account identity mismatch');
        }
        const peer = await client.query(
            "select count(*)::integer as count from item_catalog where account_name=$1 and sku like 'S624%' and sku<>$2 and tracking_level='CASE' and units_per_case=6 and not blocked",
            [ACCOUNT, SKU]
        );
        if (peer.rows[0].count < 5) throw new Error('Zeta S624 case configuration changed');
        const barcode = await client.query(
            "select sku from item_catalog where account_name=$1 and regexp_replace(upc, '\\.0$', '')=$2 and sku<>$3",
            [ACCOUNT, UPC, SKU]
        );
        if (barcode.rowCount) throw new Error('UPC already belongs to another Zeta SKU');
        const existing = await client.query(
            'select sku,description,upc,tracking_level,unit_uom,units_per_case,lot_tracked,expiration_tracked,blocked,item_type from item_catalog where account_name=$1 and sku=$2 for update',
            [ACCOUNT, SKU]
        );
        let outcome = 'already_exists';
        if (existing.rowCount) {
            const item = existing.rows[0];
            if (item.description !== DESCRIPTION || item.upc !== UPC || item.tracking_level !== 'CASE'
                || Number(item.units_per_case) !== 6 || item.blocked) {
                throw new Error('Existing Zeta SKU differs from requested item');
            }
        } else {
            await client.query(
                `insert into item_catalog
                 (account_name,sku,description,upc,tracking_level,unit_uom,units_per_case,
                  lot_tracked,expiration_tracked,blocked,item_type)
                 values ($1,$2,$3,$4,'CASE','',6,false,false,false,'INVENTORY')`,
                [ACCOUNT, SKU, DESCRIPTION, UPC]
            );
            outcome = 'created';
        }
        await client.query('commit');
        committed = true;
        const readback = await client.query(
            'select account_name,sku,description,upc,tracking_level,unit_uom,units_per_case,lot_tracked,expiration_tracked,blocked,item_type from item_catalog where account_name=$1 and sku=$2',
            [ACCOUNT, SKU]
        );
        if (readback.rowCount !== 1 || readback.rows[0].description !== DESCRIPTION
            || readback.rows[0].upc !== UPC || readback.rows[0].tracking_level !== 'CASE'
            || Number(readback.rows[0].units_per_case) !== 6 || readback.rows[0].blocked) {
            throw new Error('Item readback did not match');
        }
        console.log(JSON.stringify({ outcome, item: readback.rows[0] }));
    } catch (error) {
        if (!committed) await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
