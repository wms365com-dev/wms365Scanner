"use strict";

const { Pool } = require("pg");

const ACCOUNT_NAME = "PACKFIRE";
const APPLY = process.argv.includes("--apply");

function readEnv(name) {
    return String(process.env[name] || "").trim().replace(/^(\"|')(.*)\1$/, "$2");
}

async function main() {
    const databaseUrl = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    if (!databaseUrl) throw new Error("DATABASE_URL is unavailable.");
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: /localhost|127\.0\.0\.1|railway\.internal/i.test(databaseUrl) ? false : { rejectUnauthorized: false }
    });
    const client = await pool.connect();
    try {
        await client.query("begin");
        const ownerResult = await client.query(
            `select id, name, is_active from owner_accounts where name = $1 for update`,
            [ACCOUNT_NAME]
        );
        if (ownerResult.rowCount !== 1) throw new Error("Exact active PACKFIRE account was not found.");
        if (ownerResult.rows[0].is_active !== true) throw new Error("PACKFIRE account is not active.");

        const integrationResult = await client.query(
            `select id, account_name, provider, integration_name, store_identifier,
                    import_status, is_active, sync_schedule, settings
             from store_integrations
             where account_name = $1 and provider = 'SHOPIFY'
             order by id
             for update`,
            [ACCOUNT_NAME]
        );
        if (integrationResult.rowCount !== 1) {
            throw new Error(`Expected exactly one PACKFIRE Shopify integration, found ${integrationResult.rowCount}.`);
        }
        const before = integrationResult.rows[0];
        if (before.is_active !== true) throw new Error("PACKFIRE Shopify integration is not active.");
        if (before.settings?.syncOrders !== true) throw new Error("PACKFIRE Shopify order sync is not enabled.");

        const existingOrders = await client.query(
            `select o.status, count(*)::int as count
             from store_order_imports soi
             join portal_orders o on o.id = soi.portal_order_id
             where soi.integration_id = $1
             group by o.status
             order by o.status`,
            [before.id]
        );

        if (APPLY && before.import_status !== "RELEASED") {
            await client.query(
                `update store_integrations
                 set import_status = 'RELEASED', updated_at = now()
                 where id = $1 and account_name = $2 and provider = 'SHOPIFY'`,
                [before.id, ACCOUNT_NAME]
            );
        }
        const after = (await client.query(
            `select id, account_name, provider, integration_name, store_identifier,
                    import_status, is_active, sync_schedule, settings
             from store_integrations where id = $1`,
            [before.id]
        )).rows[0];
        if (APPLY && after.import_status !== "RELEASED") {
            throw new Error("PACKFIRE Shopify import status did not save as RELEASED.");
        }

        if (APPLY) await client.query("commit");
        else await client.query("rollback");
        console.log(JSON.stringify({
            mode: APPLY ? "apply" : "read-only",
            exactAccount: after.account_name,
            integrationId: String(after.id),
            integrationName: after.integration_name,
            storeIdentifier: after.store_identifier,
            active: after.is_active === true,
            syncSchedule: after.sync_schedule,
            syncOrders: after.settings?.syncOrders === true,
            beforeImportStatus: before.import_status,
            afterImportStatus: after.import_status,
            existingImportedOrdersUnchanged: existingOrders.rows
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
