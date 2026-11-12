"use strict";

const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const SCOPE = Object.freeze({
    integrationId: 4,
    accountName: "RANCHER'S CHIPS",
    store: "f1acxk-dc.myshopify.com",
    warehouseId: 1,
    warehouseCode: "GW3PL-MISS",
    schedule: "WEEKDAYS_5X_0600_1600"
});

function clean(value) {
    return String(value || "").trim().replace(/^(\"|')(.*)\1$/, "$2");
}

async function main() {
    const connectionString = clean(process.env.DATABASE_PRIVATE_URL) || clean(process.env.DATABASE_URL);
    if (!connectionString) throw new Error("Database connection is unavailable.");

    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        await db.query(APPLY ? "begin" : "begin read only");
        const integrationResult = await db.query(
            `select id, account_name, provider, store_identifier, is_active, settings,
                    sync_schedule, next_scheduled_sync_at, last_synced_at,
                    last_sync_status, last_sync_message
             from store_integrations
             where id = $1
             ${APPLY ? "for update" : ""}`,
            [SCOPE.integrationId]
        );
        if (integrationResult.rowCount !== 1) throw new Error("Rancher's integration ID 4 is unavailable.");
        const integration = integrationResult.rows[0];
        if (integration.account_name !== SCOPE.accountName
            || integration.provider !== "SHOPIFY"
            || String(integration.store_identifier || "").toLowerCase() !== SCOPE.store
            || integration.is_active !== true) {
            throw new Error("Rancher's integration identity check failed.");
        }

        const warehouseResult = await db.query(
            `select id, code, is_active from fulfillment_locations where id = $1`,
            [SCOPE.warehouseId]
        );
        const warehouse = warehouseResult.rows[0];
        if (warehouseResult.rowCount !== 1 || warehouse.code !== SCOPE.warehouseCode || warehouse.is_active !== true) {
            throw new Error("Rancher's warehouse identity check failed.");
        }

        const settings = integration.settings && typeof integration.settings === "object" ? integration.settings : {};
        if (settings.syncOrders !== true) throw new Error("Rancher's Shopify order import is not enabled.");

        if (APPLY) {
            await db.query(
                `update store_integrations
                 set sync_schedule = $2,
                     next_scheduled_sync_at = now(),
                     updated_at = now()
                 where id = $1`,
                [SCOPE.integrationId, SCOPE.schedule]
            );
            await db.query(
                `insert into activity_log (type, title, details)
                 values ('integration', $1, $2)`,
                [
                    "Configured Rancher's weekday Shopify order pulls",
                    "Weekdays at 6:00 AM, 8:30 AM, 11:00 AM, 1:30 PM, and 4:00 PM America/New_York; immediate worker verification queued."
                ]
            );
        }

        const current = (await db.query(
            `select sync_schedule, next_scheduled_sync_at, last_synced_at,
                    last_sync_status, last_sync_message, sync_claimed_at
             from store_integrations where id = $1`,
            [SCOPE.integrationId]
        )).rows[0];

        await db.query(APPLY ? "commit" : "rollback");
        console.log(JSON.stringify({
            ok: true,
            mode: APPLY ? "APPLY" : "READ_ONLY",
            scope: SCOPE,
            syncOrders: settings.syncOrders === true,
            syncInventory: settings.syncInventory === true,
            syncShipmentConfirmations: settings.syncShipmentConfirmations === true,
            current
        }, null, 2));
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
