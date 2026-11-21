"use strict";

const { Client } = require("pg");

const ACCOUNT = "NOMMM CANADA INC.";
const INTEGRATION_ID = 6;
const STORE = "fresh-canvas-studio-74lsu.myshopify.com";
const APPLY = process.argv.includes("--apply");
const EXPECTED_CONFIRMATION = "ENABLE-NOMMM-15-MINUTE-AUTO-RELEASE";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection unavailable.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin");
        if (!APPLY) await client.query("set transaction read only");
        if (APPLY) await client.query("select pg_advisory_xact_lock(hashtext($1))", [`nommm-shopify-auto-release:${INTEGRATION_ID}`]);
        const result = await client.query(
            `select id,account_name,store_identifier,provider,is_active,settings,import_status,sync_schedule
               from store_integrations
              where id=$1 and account_name=$2 and provider='SHOPIFY'
                and lower(store_identifier)=$3`,
            [INTEGRATION_ID, ACCOUNT, STORE]
        );
        if (result.rowCount !== 1 || result.rows[0].is_active !== true) {
            throw new Error("Exact active NomNom Shopify integration was not found.");
        }
        const row = result.rows[0];
        const settings = row.settings || {};
        if (settings.syncOrders !== true || settings.syncInventory === true
            || settings.syncShipmentConfirmations === true || settings.notifyCustomerOnFulfillment === true) {
            throw new Error("NomNom integration safety controls do not match the approved order-only scope.");
        }
        if (APPLY) {
            if (String(process.env.NOMMM_AUTO_RELEASE_CONFIRM || "") !== EXPECTED_CONFIRMATION) {
                throw new Error(`Refusing apply without NOMMM_AUTO_RELEASE_CONFIRM=${EXPECTED_CONFIRMATION}.`);
            }
            await client.query(
                `update store_integrations
                    set import_status='RELEASED',sync_schedule='EVERY_15_MINUTES',
                        next_scheduled_sync_at=now(),updated_at=now()
                  where id=$1 and account_name=$2`,
                [INTEGRATION_ID, ACCOUNT]
            );
        }
        const summary = {
            mode: APPLY ? "apply" : "read-only",
            account: ACCOUNT,
            integrationId: INTEGRATION_ID,
            store: STORE,
            current: { importStatus: row.import_status, schedule: row.sync_schedule },
            target: { importStatus: "RELEASED", schedule: "EVERY_15_MINUTES" },
            controls: {
                ordersEnabled: settings.syncOrders === true,
                inventoryExportDisabled: settings.syncInventory !== true,
                shipmentExportDisabled: settings.syncShipmentConfirmations !== true,
                buyerNotificationsDisabled: settings.notifyCustomerOnFulfillment !== true
            }
        };
        if (APPLY) await client.query("commit");
        else await client.query("rollback");
        console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
