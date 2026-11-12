"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is unavailable");
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20261019_store_integration_weekday_5x_schedule.sql"), "utf8");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        await db.query("begin");
        await db.query("select pg_advisory_xact_lock($1,$2)", [365, 20261019]);
        const scope = await db.query(
            `select si.id,si.account_name,si.provider,si.store_identifier,si.is_active,
                    fl.id warehouse_id,fl.code warehouse_code,fl.is_active warehouse_active
             from store_integrations si cross join fulfillment_locations fl
             where si.id=4 and fl.id=1 for update of si,fl`
        );
        const row = scope.rows[0];
        if (scope.rowCount !== 1 || row.account_name !== "RANCHER'S CHIPS" || row.provider !== "SHOPIFY"
            || String(row.store_identifier || "").toLowerCase() !== "f1acxk-dc.myshopify.com"
            || row.is_active !== true || row.warehouse_code !== "GW3PL-MISS" || row.warehouse_active !== true) {
            throw new Error("Rancher's production identity check failed");
        }
        await db.query(sql);
        await db.query("commit");
        const verified = await db.query(
            `select pg_get_constraintdef(oid) definition from pg_constraint
             where conrelid='store_integrations'::regclass and conname='store_integrations_sync_schedule_check'`
        );
        if (!verified.rows[0]?.definition.includes("WEEKDAYS_5X_0600_1600")) {
            throw new Error("Schedule constraint verification failed");
        }
        console.log(JSON.stringify({ ok: true, migration: "20261019_store_integration_weekday_5x_schedule" }));
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
