"use strict";

const { Pool } = require("pg");
const worker = require("../shopify-tracking-worker");
const { createShopifyTrackingApi } = require("../shopify-tracking-api");
const { createPublicHttpTracking } = require("../carrier-public-http");

const SCOPE = Object.freeze({ integrationId: 4, account: "RANCHER'S CHIPS",
    store: "f1acxk-dc.myshopify.com", warehouseId: 1, warehouseCode: "GW3PL-MISS",
    databaseRole: "wms365_tracking_4" });

function assertScope(row, identity, violations) {
    if (String(row?.id) !== String(SCOPE.integrationId) || row.account_name !== SCOPE.account
        || row.store_identifier !== SCOPE.store || row.provider !== "SHOPIFY" || row.is_active !== true
        || !worker.canTrack(row)) throw Error("RECONCILIATION_INTEGRATION_SCOPE_MISMATCH");
    if (identity?.role !== SCOPE.databaseRole) throw Error("RECONCILIATION_RESTRICTED_ROLE_REQUIRED");
    if (!Number.isSafeInteger(violations) || violations !== 0) throw Error("RECONCILIATION_WAREHOUSE_SCOPE_MISMATCH");
}

async function preflight(pool, api) {
    const client = await pool.connect();
    try {
        await client.query("begin read only");
        await client.query("set local statement_timeout='20s'");
        const identity = (await client.query("select current_user as role")).rows[0];
        const rows = await client.query("select * from store_integrations where id=$1", [SCOPE.integrationId]);
        const violations = await client.query(`select count(*)::int as count from (
            select o.id from portal_orders o join store_order_imports imp on imp.portal_order_id=o.id
              where imp.integration_id=$1 and o.status='SHIPPED'
                and (o.account_name<>$2 or o.fulfillment_location_id is distinct from $3::bigint)
            union all
            select t.id from shipment_trackers t join portal_orders o on o.id=t.order_id
              join store_order_imports imp on imp.portal_order_id=o.id and imp.integration_id=$1
              left join warehouse_shipments s on s.id=t.warehouse_shipment_id
              where o.status='SHIPPED' and (t.account_name<>$2 or o.account_name<>$2
                or t.fulfillment_location_id is distinct from $3::bigint
                or s.fulfillment_location_id is distinct from $3::bigint or s.account_name is distinct from $2
                or s.order_id is distinct from o.id or s.status is distinct from 'SHIPPED')
            union all
            select p.id from shopify_tracking_packages p
              join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id
              where f.integration_id=$1 and (f.account_name<>$2 or f.store_identifier<>$4
                or p.account_name<>$2 or p.order_id<>f.order_id
                or p.fulfillment_location_id is distinct from $3::bigint)
        ) invalid`, [SCOPE.integrationId, SCOPE.account, SCOPE.warehouseId, SCOPE.store]);
        assertScope(rows.rows.length === 1 ? rows.rows[0] : null, identity, violations.rows[0]?.count);
        await worker.assertFeatures(client, SCOPE.account);
        await client.query("rollback");
        await api.verify(rows.rows[0]);
        return rows.rows[0];
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally { client.release(); }
}

async function snapshot(pool) {
    const trackers = await pool.query(`select t.status,count(distinct t.id)::int as count
        from shipment_trackers t join warehouse_shipments s on s.id=t.warehouse_shipment_id
          and s.order_id=t.order_id and s.account_name=t.account_name and s.fulfillment_location_id=t.fulfillment_location_id
        join portal_orders o on o.id=t.order_id and o.account_name=t.account_name
        join store_order_imports imp on imp.portal_order_id=o.id and imp.integration_id=$1
        where t.account_name=$2 and t.fulfillment_location_id=$3 and o.status='SHIPPED' and s.status='SHIPPED'
        group by t.status order by t.status`, [SCOPE.integrationId, SCOPE.account, SCOPE.warehouseId]);
    const outbox = await pool.query(`select b.state,count(*)::int as count from shopify_tracking_outbox b
        join shopify_tracking_fulfillments f on f.id=b.fulfillment_binding_id
        where f.integration_id=$1 and f.account_name=$2 and f.store_identifier=$3 and b.discarded_at is null
        group by b.state order by b.state`, [SCOPE.integrationId, SCOPE.account, SCOPE.store]);
    return { trackerStatuses: trackers.rows, outboxStates: outbox.rows };
}

async function reconcile(pool, { apply = false, api = createShopifyTrackingApi(), reader,
    runCycle = worker.runCycle } = {}) {
    const integration = await preflight(pool, api);
    const before = await snapshot(pool);
    if (!apply) return { mode: "READ_ONLY", scope: SCOPE, before };
    const lockClient = await pool.connect();
    let locked = false;
    try {
        const lock = await lockClient.query("select pg_try_advisory_lock(hashtext('public-tracking-worker'),$1::integer) as locked", [SCOPE.integrationId]);
        locked = lock.rows[0]?.locked === true;
        if (!locked) return { mode: "APPLY", scope: SCOPE, deferred: "LIVE_WORKER_BUSY", before };
        // Recheck scope after acquiring the same lock as the production worker.
        await preflight(pool, api);
        const report = await runCycle(pool, SCOPE.integrationId, { api, reader,
            discoverOrders: true, approveHistorical: process.env.TRACKING_APPROVE_HISTORY === "true"
                && Boolean(process.env.TRACKING_HISTORY_CUTOFF), actor: process.env.TRACKING_APPROVAL_ACTOR,
            carriers: ["CANPAR", "ICS_COURIER", "GLS"] });
        return { mode: "APPLY", scope: SCOPE, before, report, after: await snapshot(pool),
            warning: worker.trackingWarning(report), remoteReadbackRequired: true,
            observedTimeEnabled: integration.settings?.carrierUnverifiedTimeMode === "OBSERVED" };
    } finally {
        try { if (locked) await lockClient.query("select pg_advisory_unlock(hashtext('public-tracking-worker'),$1::integer)", [SCOPE.integrationId]); }
        finally { lockClient.release(); }
    }
}

async function main(args = process.argv.slice(2)) {
    if (args.some(arg => arg !== "--apply")) throw Error("RECONCILIATION_ARGUMENT_INVALID");
    if (!process.env.DATABASE_URL) throw Error("RECONCILIATION_DATABASE_REQUIRED");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 20000,
        options: "-c search_path=wms365_tracking_4,public,pg_catalog" });
    try {
        const browserFallback = process.env.TRACKING_BROWSER_ENABLED === "true"
            ? require("../carrier-public-tracking").createPublicCarrierTracking({ diagnosticDir: process.env.TRACKING_DIAGNOSTIC_DIR }) : null;
        const result = await reconcile(pool, { apply: args.includes("--apply"), reader: createPublicHttpTracking({ browserFallback }) });
        const output = { generatedAt: new Date().toISOString(), ...result };
        console.log(JSON.stringify(output));
        return output;
    } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => {
    const allowed = /^RECONCILIATION_[A-Z_]+$/.test(error.message || "");
    console.error(allowed ? error.message : worker.safeError(error, "RECONCILIATION_FAILED"));
    process.exitCode = 1;
});
module.exports = { SCOPE, assertScope, preflight, snapshot, reconcile, main };
