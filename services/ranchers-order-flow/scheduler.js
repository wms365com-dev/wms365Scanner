"use strict";

const { Client } = require("pg");
const { SheetsClient, configuredGoogleAuth, syncOnce } = require("./ranchers-label-sheet-sync");
const { main: readSnapshot } = require("./scripts/read-ranchers-clickship-queue");

const SCOPE = Object.freeze({
    integrationId: 4,
    accountName: "RANCHER'S CHIPS",
    store: "f1acxk-dc.myshopify.com",
    warehouseId: 1,
    warehouseCode: "GW3PL-MISS"
});
const SLOTS = new Set(["06:00", "08:30", "11:00", "13:30", "16:00"]);
const TIME_ZONE = "America/New_York";
const LOCK_KEYS = [365, 20261019];

function easternSlot(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const time = `${parts.hour}:${parts.minute}`;
    if (["Sat", "Sun"].includes(parts.weekday) || !SLOTS.has(time)) return null;
    return `${parts.year}-${parts.month}-${parts.day}T${time}`;
}

async function verifyScope(db) {
    const result = await db.query(
        `select si.id,si.account_name,si.provider,si.store_identifier,si.is_active,si.settings,
                fl.id warehouse_id,fl.code warehouse_code,fl.is_active warehouse_active
         from store_integrations si cross join fulfillment_locations fl
         where si.id=$1 and fl.id=$2`,
        [SCOPE.integrationId, SCOPE.warehouseId]
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || row.account_name !== SCOPE.accountName || row.provider !== "SHOPIFY"
        || String(row.store_identifier || "").toLowerCase() !== SCOPE.store || row.is_active !== true
        || row.warehouse_code !== SCOPE.warehouseCode || row.warehouse_active !== true
        || row.settings?.syncOrders !== true) {
        throw new Error("Rancher's production identity check failed");
    }
}

async function queueSlot(db, slot) {
    await db.query("begin");
    try {
        await db.query("select pg_advisory_xact_lock($1,$2)", LOCK_KEYS);
        await verifyScope(db);
        const marker = `ranchers-order-flow:${slot}`;
        const prior = await db.query("select 1 from activity_log where type='integration' and details=$1 limit 1", [marker]);
        if (prior.rowCount) {
            await db.query("rollback");
            return { queued: false, marker };
        }
        const before = await db.query("select last_synced_at from store_integrations where id=$1 for update", [SCOPE.integrationId]);
        await db.query("update store_integrations set next_scheduled_sync_at=now(),updated_at=now() where id=$1", [SCOPE.integrationId]);
        await db.query(
            "insert into activity_log(type,title,details) values('integration',$1,$2)",
            ["Queued Rancher's scheduled Shopify order pull", marker]
        );
        await db.query("commit");
        return { queued: true, marker, previousSyncAt: before.rows[0]?.last_synced_at || null };
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    }
}

async function waitForWorker(db, previousSyncAt, timeoutMs = 240000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await db.query(
            "select last_synced_at,last_sync_status,last_sync_message,sync_claimed_at from store_integrations where id=$1",
            [SCOPE.integrationId]
        );
        const row = result.rows[0];
        const advanced = row?.last_synced_at && (!previousSyncAt || new Date(row.last_synced_at) > new Date(previousSyncAt));
        if (advanced && !row.sync_claimed_at) return row;
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error("Shopify worker did not confirm completion within four minutes");
}

async function run({ now = new Date(), forceSlot = null } = {}) {
    const slot = forceSlot || easternSlot(now);
    if (!slot) return { state: "OUTSIDE_SLOT" };
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("WMS365 database connection unavailable");
    const database = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await database.connect();
    try {
        const queued = await queueSlot(database, slot);
        if (!queued.queued) return { state: "ALREADY_PROCESSED", slot };
        const worker = await waitForWorker(database, queued.previousSyncAt);
        const sheets = new SheetsClient(configuredGoogleAuth());
        const sheet = await syncOnce({
            database,
            sheets,
            loadSnapshot: (client) => readSnapshot({ client, print: false, statuses: ["RELEASED", "STAGED"] })
        });
        return { state: "COMPLETED", slot, workerStatus: worker.last_sync_status,
            sheetState: sheet.state, appended: sheet.appended };
    } finally {
        await database.end();
    }
}

if (require.main === module) {
    run().then((result) => console.log(JSON.stringify(result))).catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { SCOPE, SLOTS, easternSlot, run };
