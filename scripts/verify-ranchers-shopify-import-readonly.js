const { Client } = require("pg");

const ACCOUNT_NAME = "RANCHER'S CHIPS";
const SHOP_DOMAIN = "f1acxk-dc.myshopify.com";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const integrationResult = await client.query(
            `select id, sync_schedule, last_sync_status, last_sync_message, last_synced_at,
                    next_scheduled_sync_at, sync_claimed_at
             from store_integrations
             where account_name = $1 and provider = 'SHOPIFY' and lower(store_identifier) = $2
             limit 1`,
            [ACCOUNT_NAME, SHOP_DOMAIN]
        );
        const integration = integrationResult.rows[0];
        if (!integration) throw new Error("Rancher's Shopify integration was not found.");
        const orderResult = await client.query(
            `select count(*)::int as imported_count,
                    count(*) filter (where o.status = 'RELEASED')::int as released_count,
                    count(*) filter (where o.status = 'DRAFT')::int as draft_count,
                    count(*) filter (where o.status = 'PICKED')::int as picked_count,
                    count(*) filter (where o.status = 'STAGED')::int as staged_count,
                    count(*) filter (where o.status = 'SHIPPED')::int as shipped_count,
                    min(o.created_at) as earliest_wms_created_at,
                    max(o.created_at) as latest_wms_created_at
             from store_order_imports s
             join portal_orders o on o.id = s.portal_order_id
             where s.integration_id = $1 and o.account_name = $2`,
            [integration.id, ACCOUNT_NAME]
        );
        console.log(JSON.stringify({
            ok: true,
            integration: integration,
            orders: orderResult.rows[0]
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
