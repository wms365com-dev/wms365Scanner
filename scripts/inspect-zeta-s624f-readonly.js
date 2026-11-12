const { Client } = require('pg');

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== '3f4e7e7e-7eda-4275-8dd0-2c1c3f869698'
        || process.env.RAILWAY_ENVIRONMENT_ID !== 'e1f5b77e-b935-4f41-9cc5-fccb28edbc57'
        || process.env.RAILWAY_SERVICE_ID !== '2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0') {
        throw new Error('WMS365 production target mismatch');
    }
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query('begin read only');
        const accounts = await client.query(
            "select id,name,is_active from owner_accounts where name = 'ZETA GROUP (CANADA) LTD.'"
        );
        const existing = await client.query(
            "select account_name,sku,description,upc,tracking_level,unit_uom,uom_label,units_per_case,lot_tracked,expiration_tracked,blocked,item_type,item_category from item_catalog where (account_name = 'ZETA GROUP (CANADA) LTD.' and (sku = 'S624F' or upc = '19421908626341')) or sku = 'S624F' or upc = '19421908626341' order by account_name,sku"
        );
        const peers = await client.query(
            "select sku,description,upc,tracking_level,unit_uom,uom_label,units_per_case,lot_tracked,expiration_tracked,blocked,item_type,item_category from item_catalog where account_name = 'ZETA GROUP (CANADA) LTD.' and (sku ilike 'S62%' or description ilike '%Facial Cleansing Towel%') order by sku limit 80"
        );
        await client.query('rollback');
        console.log(JSON.stringify({ accounts: accounts.rows, existing: existing.rows, peers: peers.rows }));
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
