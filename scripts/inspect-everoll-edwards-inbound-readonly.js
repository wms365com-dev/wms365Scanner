const { Client } = require("pg");

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000
    });
    await client.connect();
    try {
        const queries = [
            ["company_columns", `select table_name, column_name, data_type from information_schema.columns
                where table_schema='public' and table_name in ('companies','company_accounts','portal_inbounds','portal_inbound_lines','company_fulfillment_locations','inventory_lines','inventory_transactions')
                order by table_name, ordinal_position`],
            ["locations", `select id, code, name, address1, city, is_active from fulfillment_locations where id in (1,143)`],
            ["account", `select id, name, is_active from owner_accounts where name='EVEROLL INDUSTRIES LTD'`],
            ["assignment_defaults", `select column_name, column_default from information_schema.columns
                where table_schema='public' and table_name='company_fulfillment_locations' order by ordinal_position`],
            ["assignments", `select cfl.*
                from company_fulfillment_locations cfl where cfl.account_name ilike '%EVEROLL%'`],
            ["items", `select id, account_name, sku, description, tracking_level, unit_uom, units_per_case
                from item_catalog where account_name ilike '%EVEROLL%' or sku like 'ESP72-%' order by account_name, sku`],
            ["inbounds", `select * from portal_inbounds where account_name ilike '%EVEROLL%' order by id desc limit 20`],
            ["duplicate_reference", `select id, inbound_code, status from portal_inbounds
                where account_name='EVEROLL INDUSTRIES LTD' and reference_number='EVEROLL-IWF-KTS-20260918-6SKIDS'`],
            ["stage_inventory", `select account_name, location, sum(quantity)::integer as pieces from inventory_lines
                where location='WHS01-EVEROLL-REC' group by account_name, location`],
            ["sku_inventory", `select sku, sum(quantity)::integer as pieces from inventory_lines
                where account_name='EVEROLL INDUSTRIES LTD' and sku=any(array['ESP72-47-WHT','ESP72-36-WHT','ESP72-47-BLK','ESP72-36-BLK'])
                group by sku`],
            ["bins", `select id, code, location_type, is_pickable from bin_locations where code ilike 'DE%' order by code limit 15`]
        ];
        for (const [label, sql] of queries) {
            try {
                const result = await client.query(sql);
                console.log(JSON.stringify({ label, rows: result.rows }));
            } catch (error) {
                console.log(JSON.stringify({ label, error: error.code || error.message }));
            }
        }
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
});
