const { Client } = require("pg");

const ACCOUNT_NAME = "RANCHER'S CHIPS";
const SHOP_DOMAIN = "f1acxk-dc.myshopify.com";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        await client.query("begin");
        const result = await client.query(
            `select i.id, i.settings,
                    (select count(*)::int from store_sku_mappings m where m.integration_id = i.id) as mapping_count
             from store_integrations i
             where i.account_name = $1 and i.provider = 'SHOPIFY' and lower(i.store_identifier) = $2
             for update`,
            [ACCOUNT_NAME, SHOP_DOMAIN]
        );
        const integration = result.rows[0];
        if (!integration) throw new Error("Rancher's Shopify integration was not found.");
        if (Number(integration.mapping_count) !== 7) {
            throw new Error(`Expected 7 Rancher's SKU mappings, found ${integration.mapping_count}.`);
        }
        const settings = integration.settings && typeof integration.settings === "object" ? integration.settings : {};
        if (!settings.shopifyLocationId || settings.syncOrders !== true || settings.syncInventory !== true) {
            throw new Error("Rancher's Shopify order and inventory settings are incomplete.");
        }

        await client.query(
            `update store_integrations
             set is_active = true,
                 sync_schedule = 'EVERY_5_MINUTES',
                 next_scheduled_sync_at = now(),
                 last_sync_status = 'IDLE',
                 last_sync_message = 'Initial Canadian order import queued.',
                 updated_at = now()
             where id = $1`,
            [integration.id]
        );
        await client.query(
            `insert into activity_log (type, title, details)
             values ('integration', $1, $2)`,
            [
                `Activated Rancher's Shopify synchronization`,
                `Every 5 minutes | Canada only | 7 shared-inventory SKU mappings | initial import queued`
            ]
        );
        await client.query("commit");
        console.log(JSON.stringify({
            ok: true,
            accountName: ACCOUNT_NAME,
            schedule: "EVERY_5_MINUTES",
            initialSyncQueued: true,
            mappingCount: Number(integration.mapping_count)
        }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
