const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const sync = require("./shopify-tracking-sync");

const at = "2026-09-17T12:00:00.000Z";
const binding = { id: 2, integration_id: 3, account_name: "TEST COMPANY", store_identifier: "fixture.myshopify.com",
    external_order_id: "99", fulfillment_gid: "gid://shopify/Fulfillment/88", enrolled_at: at,
    expires_at: "2027-11-01T12:00:00.000Z", expected_tracking_numbers: ["PACKAGE-A", "PACKAGE-B"] };
const integration = { id: 3, account_name: "TEST COMPANY", store_identifier: "fixture.myshopify.com", is_active: true,
    settings: { carrierFulfillmentEventsEnabled: true } };

test("rediscovery SQL keeps future retry times, errors and attempts while respecting closed and foreign packages",async()=>{
    let update;
    const capture={async query(sql,args){if(sql.startsWith("update shipment_trackers t"))update={sql,args};return {
        rows:sql.startsWith("insert into shopify_tracking_fulfillments") ? [{...binding,expires_at:"2080-01-01T00:00:00Z"}] : []};}};
    await sync.bindFulfillment(capture,integration,{id:99,accountName:integration.account_name},"99",{id:"88"},["TEST"]);
    const db=require("pg-mem").newDb();
    db.public.none(`create table shipment_trackers(id int,status text,next_poll_at timestamptz,attempts int,
        is_active boolean,manual_closed_at timestamptz,claimed_at timestamptz,last_error text);
        create table shopify_tracking_packages(fulfillment_binding_id int,tracker_id int);
        insert into shipment_trackers values
          (1,'PENDING','2079-01-01',7,true,null,null,'LAYOUT_REVIEW_REQUIRED'),
          (2,'PENDING',null,0,false,null,null,''),
          (3,'PENDING','2079-01-01',7,false,'2026-09-18',null,'CLOSED'),
          (4,'PENDING','2079-01-01',7,true,null,'2026-09-18','CLAIMED'),
          (5,'PENDING','2079-01-01',7,true,null,null,'OTHER_BINDING'),
          (6,'DELIVERED','2079-01-01',0,true,null,null,'');
        insert into shopify_tracking_packages values (2,1),(2,2),(2,3),(2,4),(9,5),(2,6);`);
    const pg=db.adapters.createPg();const client=new pg.Client();await client.connect();
    // pg-mem cannot resolve aliases on UPDATE targets; keep the same expressions and predicates.
    const executable=update.sql.replace('update shipment_trackers t','update shipment_trackers').replace(/\bt\./g,'shipment_trackers.');
    try{await client.query(executable,update.args);const rows=(await client.query('select * from shipment_trackers order by id')).rows;
        assert.equal(rows[0].next_poll_at.toISOString(),'2079-01-01T00:00:00.000Z');
        assert.equal(rows[0].attempts,7);assert.equal(rows[0].last_error,'LAYOUT_REVIEW_REQUIRED');
        assert.ok(rows[1].next_poll_at);assert.equal(rows[1].is_active,true);
        assert.equal(rows[2].is_active,false);assert.equal(rows[2].last_error,'CLOSED');
        assert.equal(rows[3].attempts,7);assert.equal(rows[3].last_error,'CLAIMED');
        assert.equal(rows[4].attempts,7);assert.equal(rows[4].last_error,'OTHER_BINDING');
        assert.equal(rows[5].next_poll_at,null);assert.equal(rows[5].is_active,false);
    }finally{await client.end()}
});

function scan(status, extra = {}) {
    return { status, source: "AFTERSHIP", event_at: at, safe_metadata: { carrier_scan: true }, ...extra };
}

test("only per-store explicit opt-in enables tracking and email send state stays UNKNOWN", () => {
    assert.equal(sync.deliverySettings().carrierFulfillmentEventsEnabled, false);
    assert.equal(sync.deliverySettings({ settings: { enabled: true } }).carrierFulfillmentEventsEnabled, false);
    assert.equal(sync.deliverySettings({ settings: { carrierFulfillmentEventsEnabled: "true" } }).carrierFulfillmentEventsEnabled, false);
    assert.equal(sync.deliverySettings(integration).carrierFulfillmentEventsEnabled, true);
    assert.equal(sync.deliverySettings(integration).shopifySendState, "UNKNOWN");
});

test("server notification retry permits only proven-not-sent failures", () => {
    const { canRetryShopifyDeliveryNotification: canRetry, mapShopifyDeliveryNotificationLog: mapLog } = require("./server");
    const failed = { id: 1, integration_id: 11, status: "FAILED", outcome_code: "PROVIDER_CONFIRMED_NOT_SENT",
        event_type: "SHIPPED", channel: "EMAIL", shopify_send_state: "REQUESTED" };
    assert.equal(canRetry(failed), true);
    assert.equal(canRetry({ ...failed, outcome_code: "PROVIDER_CHANNEL_UNAVAILABLE" }), true);
    for (const status of ["UNCERTAIN", "SENT", "SENDING", "PENDING", "DEFERRED", "SUPPRESSED"]) {
        assert.equal(canRetry({ ...failed, status }), false);
    }
    for (const extra of [{ outcome_code: "SEND_ERROR_OR_TIMEOUT" }, { outcome_code: "UNKNOWN" },
        { sent_at: at }, { provider_message_id: "receipt" }, { claim_token: "active-claim" }]) {
        assert.equal(canRetry({ ...failed, ...extra }), false);
    }
    const mapped = mapLog(failed);
    assert.equal(mapped.status, "SHIPPED");
    assert.equal(mapped.result, "FAILED");
    assert.equal(mapped.shopifySendState, "REQUESTED");
    assert.equal(mapped.sentAt, null);
});

test("notification log SQL excludes other companies, warehouses, orders, shipments, stores and packages", async () => {
    const { newDb } = require("pg-mem");
    const { getScopedTrackerNotificationRows } = require("./server");
    const db = newDb();
    db.public.none(`create table store_integrations(id bigint,account_name text,provider text,store_identifier text);
        create table shopify_tracking_fulfillments(id bigint,integration_id bigint,store_identifier text,account_name text,order_id bigint);
        create table shopify_tracking_packages(fulfillment_binding_id bigint,tracker_id bigint,account_name text,order_id bigint,
            fulfillment_location_id bigint,warehouse_shipment_id bigint,tracking_number text);
        create table shopify_delivery_notification_outbox(id bigint,integration_id bigint,account_name text,warehouse_id text,
            order_id text,shipment_id text,payload jsonb,created_at timestamptz);
        insert into store_integrations values (11,'TEST','SHOPIFY','one.myshopify.com'),(12,'TEST','SHOPIFY','two.myshopify.com');
        insert into shopify_tracking_fulfillments values (1,11,'one.myshopify.com','TEST',100),(2,12,'two.myshopify.com','TEST',100);
        insert into shopify_tracking_packages values (1,1,'TEST',100,20,30,'TEST-PACKAGE'),(2,2,'TEST',100,20,30,'TEST-PACKAGE');`);
    const pg = db.adapters.createPg();
    const client = new pg.Pool();
    try {
        const cases = [
            [1,11,"TEST","20","100","30","TEST-PACKAGE"],
            [2,11,"OTHER","20","100","30","TEST-PACKAGE"],
            [3,11,"TEST","21","100","30","TEST-PACKAGE"],
            [4,11,"TEST","20","101","30","TEST-PACKAGE"],
            [5,11,"TEST","20","100","31","TEST-PACKAGE"],
            [6,12,"TEST","20","100","30","TEST-PACKAGE"],
            [7,11,"TEST","20","100","30","OTHER-PACKAGE"]
        ];
        for (const values of cases) {
            await client.query("insert into shopify_delivery_notification_outbox values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
                [...values.slice(0, 6), JSON.stringify({ shipment: { trackingNumber: values[6] } }), at]);
        }
        const tracker = { id: 1, account_name: "TEST", fulfillment_location_id: 20, order_id: 100,
            warehouse_shipment_id: 30, tracking_number: "TEST-PACKAGE" };
        const rows = await getScopedTrackerNotificationRows(client, tracker);
        assert.deepEqual(rows.map((row) => Number(row.id)), [1]);
        assert.equal((await getScopedTrackerNotificationRows(client, tracker, { notificationId: 6 })).length, 0);
        assert.equal((await getScopedTrackerNotificationRows(client, tracker, { notificationId: 7 })).length, 0);
        assert.equal((await getScopedTrackerNotificationRows(client, { ...tracker, fulfillment_location_id: 21 })).length, 0);
    } finally { await client.end(); }
});

test("SHIPPED handoff uses imported recipient, persists REQUESTED not email success, and deduplicates", async () => {
    const { enqueueShopifyShippedNotifications } = require("./server");
    const current = { ...binding, tracking_started_at: at, shopify_notification_state: "REQUESTED" };
    const inserts = [];
    const queries = [];
    const client = { async query(sql, params) {
        queries.push({ sql, params });
        if (sql.startsWith("select * from shopify_tracking_fulfillments")) return { rows: [{ ...current }] };
        if (sql.startsWith("select t.*")) return { rows: [{ id: 4, warehouse_shipment_id: 30,
            fulfillment_location_id: 20, tracking_number: "TEST-PACKAGE", carrier_name: "Canpar",
            recipient_email: "imported@example.invalid", order_code: "TEST-ORDER" }] };
        if (sql.startsWith("SELECT id, account_name, provider")) return { rows: [{ ...integration, provider: "SHOPIFY" }] };
        if (sql.startsWith("SELECT * FROM shopify_delivery_notification_settings")) return { rows: [{ enabled: true,
            delivery_mode: "BOTH", enabled_events: ["SHIPPED"], sms_enabled: false }] };
        if (sql.startsWith("INSERT INTO shopify_delivery_notification_outbox")) {
            inserts.push(params);
            return { rows: [{ id: 1, status: "PENDING" }] };
        }
        if (sql.startsWith("update shopify_tracking_fulfillments set shipped_notifications_enqueued_at")) {
            current.shipped_notifications_enqueued_at = at;
        }
        return { rows: [] };
    } };
    assert.equal((await enqueueShopifyShippedNotifications(client, current.id)).packageCount, 1);
    assert.equal((await enqueueShopifyShippedNotifications(client, current.id)).skipped, true);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][8], "imported@example.invalid");
    assert.equal(inserts[0][12], "REQUESTED");
    assert.equal(inserts[0][14], "PENDING");
    const payload = JSON.parse(inserts[0][11]);
    assert.equal(payload.event.status, "SHIPPED");
    assert.equal(payload.shipment.companyId, binding.account_name);
    const scoped = queries.find((entry) => entry.sql.startsWith("select t.*"));
    assert.deepEqual(scoped.params.slice(0, 5), [binding.id,binding.integration_id,binding.account_name,binding.external_order_id,binding.store_identifier]);
    assert.match(scoped.sql, /store_order_imports/);
    assert.match(scoped.sql, /c\.account_name=t\.account_name/);
    assert.equal(queries.some((entry) => /portal_vendor_access|owner_accounts/.test(entry.sql)), false);
    assert.equal(queries.some((entry) => entry.sql.startsWith("savepoint delivery_")), true);
});

test("SHIPPED handoff without a stored imported recipient never falls back or queues", async () => {
    const { enqueueShopifyShippedNotifications } = require("./server");
    let calls = 0;
    const client = { async query(sql) {
        return { rows: sql.startsWith("select * from shopify_tracking_fulfillments") ? [{ ...binding }] : [] };
    } };
    const result = await enqueueShopifyShippedNotifications(client, binding.id, { enqueue: async () => { calls += 1; } });
    assert.equal(result.packageCount, 0);
    assert.equal(calls, 0);
});

test("bounded endpoint contract retains guards, safe retry predicates and native-review capabilities", () => {
    const server = fs.readFileSync(require.resolve("./server"), "utf8");
    assert.ok(server.includes('app.get("/api/admin/shipment-trackers/:id/notifications", requireScopedTrackerRefresh'));
    assert.ok(server.includes('app.post("/api/admin/shipment-trackers/:id/notifications/:notificationId/resend", requireWarehouseAdmin()'));
    const route = server.slice(server.indexOf('app.post("/api/admin/shipment-trackers/:id/notifications/:notificationId/resend"'),
        server.indexOf('app.post("/api/admin/shipment-trackers/:id/correct"'));
    assert.match(route, /requireScopedShipmentTracker/);
    assert.match(route, /notificationId, lock: true/);
    assert.match(route, /email_delivery_log where delivery_key/);
    assert.match(route, /status='FAILED' and outcome_code in/);
    assert.doesNotMatch(route, /status='UNCERTAIN'/);
    assert.match(server, /if \(binding && result\.updated !== true\) await enqueueShopifyShippedNotifications/);
    const review = server.slice(server.indexOf('app.post("/api/admin/integrations/:id/delivery-notification-review"'),
        server.indexOf('app.get("/api/admin/warehouse-tasks/:id/history"'));
    assert.match(review, /capabilities: shopifyDeliveryNotifications\.getDeliveryNotificationCapabilities/);
});

test("maps all requested carrier statuses, excluding warehouse and summary-only delivery", () => {
    for (const [status, expected] of Object.entries(sync.STATUS_MAP)) assert.equal(sync.mapCarrierEvent(scan(status)), expected);
    assert.equal(sync.mapCarrierEvent(scan("DELIVERED", { source: "WAREHOUSE" })), null);
    assert.equal(sync.mapCarrierEvent(scan("DELIVERED", { safe_metadata: {} })), null);
    assert.equal(sync.mapCarrierEvent(scan("DELIVERED", { event_at: null })), null);
    assert.equal(sync.mapCarrierEvent(scan("LABEL_CREATED")), null);
    assert.equal(sync.mapCarrierEvent(scan("RETURNED")), null);
});

test("delivery requires exactly one real confirmation for every expected package", () => {
    const packages = [{ tracking_number: "PACKAGE-A", confirmed_delivered_at: at, delivery_event_id: 1 }];
    assert.equal(sync.allPackagesDelivered(binding.expected_tracking_numbers, packages), false);
    packages.push({ tracking_number: "PACKAGE-B", confirmed_delivered_at: at, delivery_event_id: 2 });
    assert.equal(sync.allPackagesDelivered(binding.expected_tracking_numbers, packages), true);
    assert.equal(sync.allPackagesDelivered([], packages), false);
    assert.equal(sync.allPackagesDelivered(binding.expected_tracking_numbers, [...packages, packages[0]]), false);
    assert.equal(sync.allPackagesDelivered(binding.expected_tracking_numbers, packages.map((p) => ({ ...p, delivery_event_id: null }))), false);
});

test("enrolled packages use 45-minute polls and expire without changing nonenrolled compatibility", () => {
    assert.equal(sync.enrolledPollAt({}, "IN_TRANSIT", at), undefined);
    assert.equal(sync.enrolledPollAt(binding, "IN_TRANSIT", at), "2026-09-17T12:45:00.000Z");
    assert.equal(sync.enrolledPollAt(binding, "DELIVERED", at), null);
    assert.equal(sync.enrolledPollAt(binding, "RETURNED", at), "2026-09-17T12:45:00.000Z");
    assert.equal(sync.enrolledPollAt(binding, "CANCELLED", at), "2026-09-17T12:45:00.000Z");
    assert.equal(sync.enrolledPollAt(binding, "IN_TRANSIT", at, 0, at), null);
    assert.equal(sync.enrolledPollAt(binding, "IN_TRANSIT", binding.expires_at), null);
    assert.equal(sync.enrolledPollAt(binding, "IN_TRANSIT", "2027-11-01T11:50:00Z"), binding.expires_at);
    assert.equal(sync.enrolledPollAt(binding, "IN_TRANSIT", at, 10), "2026-09-18T05:04:00.000Z");
});

test("exponential retries are bounded and fulfillment IDs reject malformed identities", () => {
    assert.equal(sync.retryAt(1, at), "2026-09-17T12:02:00.000Z");
    assert.equal(sync.retryAt(2, at), "2026-09-17T12:04:00.000Z");
    assert.equal(sync.retryAt(99, at), "2026-09-18T12:00:00.000Z");
    assert.equal(sync.fulfillmentGid(88), binding.fulfillment_gid);
    assert.equal(sync.fulfillmentGid(binding.fulfillment_gid), binding.fulfillment_gid);
    assert.equal(sync.fulfillmentGid("gid://shopify/Order/88"), null);
});

function reconciliationPage(nodes = [], pageInfo = { hasNextPage: false, endCursor: null }, orderId = "gid://shopify/Order/99") {
    return { payload: { data: { fulfillment: { id: binding.fulfillment_gid, order: { id: orderId }, events: { nodes, pageInfo } } } } };
}

test("reconciliation paginates and finds matching status plus exact scan timestamp", async () => {
    const cursors = [];
    const remote = await sync.reconcileEvent(async (_integration, _path, options) => {
        cursors.push(options.body.variables.after);
        return options.body.variables.after === null
            ? reconciliationPage([{ id: "wrong-time", status: "IN_TRANSIT", happenedAt: "2026-09-16T12:00:00Z" }], { hasNextPage: true, endCursor: "page2" })
            : reconciliationPage([{ id: "remote-scan", status: "IN_TRANSIT", happenedAt: at }]);
    }, integration, binding, { status: "IN_TRANSIT", event_at: at });
    assert.equal(remote, "remote-scan");
    assert.deepEqual(cursors, [null, "page2"]);
});

test("wrong order, absent fulfillment and incomplete pages never authorize a send", async () => {
    for (const response of [reconciliationPage([], undefined, "gid://shopify/Order/100"),
        { payload: { data: { fulfillment: null } } },
        { payload: { data: { fulfillment: { id: binding.fulfillment_gid, order: { id: "gid://shopify/Order/99" }, events: {} } } } }]) {
        await assert.rejects(sync.reconcileEvent(async () => response, integration, binding, { status: "IN_TRANSIT", event_at: at }));
    }
});

function fakeClient(row, { locked = true, packages = [], activeIntegration = integration } = {}) {
    const queries = [];
    return { queries, async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.startsWith("select o.*")) return { rows: row ? [{ ...row }] : [] };
        if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked }] };
        if (sql.startsWith("select * from shopify_tracking_fulfillments")) return { rows: [{ ...binding }] };
        if (sql.startsWith("select * from store_integrations")) return { rows: activeIntegration ? [{ ...activeIntegration }] : [] };
        if (sql.startsWith("select * from shopify_tracking_packages")) return { rows: packages };
        return { rows: [] };
    } };
}

const pending = { id: 7, fulfillment_binding_id: 2, status: "IN_TRANSIT", event_at: at, attempts: 0 };

test("ambiguous timeout retries reconcile first, do not duplicate, and never assert email SUCCESS", async () => {
    let mutations = 0;
    let remoteExists = false;
    const request = async (_integration, _path, options) => {
        if (options.body.query.startsWith("query")) return reconciliationPage(remoteExists
            ? [{ id: "gid://shopify/FulfillmentEvent/1", status: pending.status, happenedAt: at }] : []);
        mutations += 1;
        remoteExists = true;
        throw new Error("Ambiguous timeout after remote acceptance, secret must not persist");
    };
    const first = fakeClient(pending);
    assert.equal((await sync.processOne(first, { request })).state, "RETRY");
    const retry = first.queries.find((q) => q.sql.includes("next_attempt_at=$4"));
    assert.equal(retry.params[2], 1);
    assert.equal(first.queries.some((q) => q.params.some((p) => String(p).includes("secret"))), false);
    const second = fakeClient({ ...pending, attempts: 1 });
    const result = await sync.processOne(second, { request });
    assert.equal(result.state, "SENT");
    assert.equal(result.notificationState, "REQUESTED");
    assert.equal(result.sendState, "UNKNOWN");
    assert.equal(mutations, 1);
    assert.match(second.queries[0].sql, /for update of o skip locked/);
    assert.match(second.queries[0].sql, /prior\.event_at,prior\.id/);
});

test("fulfillment lock conflicts and disabled stores cause zero remote calls", async () => {
    let calls = 0;
    const request = async () => { calls += 1; };
    assert.equal(await sync.processOne(fakeClient(pending, { locked: false }), { request }), null);
    assert.equal(await sync.processOne(fakeClient(pending, { activeIntegration: { ...integration, settings: {} } }), { request }), null);
    assert.equal(await sync.processOne(fakeClient(null), { request }), null);
    assert.equal(calls, 0);
});

test("incomplete multipackage deliveries and rejected feature access do not mutate Shopify", async () => {
    let calls = 0;
    const request = async () => { calls += 1; };
    const blocked = await sync.processOne(fakeClient({ ...pending, status: "DELIVERED" }), { request });
    assert.equal(blocked.state, "BLOCKED");
    const denied = await sync.processOne(fakeClient(pending), { request, assertFeatures: async () => { throw new Error("disabled"); } });
    assert.equal(denied.state, "RETRY");
    assert.equal(calls, 0);
});

test("GraphQL user errors cannot be confused with successful event or email acceptance", async () => {
    const result = await sync.processOne(fakeClient(pending), { request: async (_i, _p, options) =>
        options.body.query.startsWith("query") ? reconciliationPage() : { payload: { data: { fulfillmentEventCreate: {
            fulfillmentEvent: null, userErrors: [{ field: ["status"], message: "Denied" }]
        } } } } });
    assert.equal(result.state, "RETRY");
});

test("retry exhaustion requires explicit scoped admin replay", async () => {
    const result = await sync.processOne(fakeClient({ ...pending, attempts: 11 }), { request: async () => { throw new Error("down"); } });
    assert.equal(result.state, "BLOCKED");
});

test("pending newer events retain the last successful Shopify status and timestamp", async () => {
    const client = { async query(sql) {
        if (sql.includes("from shopify_tracking_packages")) return { rows: [{ ...binding, integration_settings: integration.settings }] };
        if (sql.includes("state='SENT'")) return { rows: [{ status: "CARRIER_PICKED_UP", sent_at: at }] };
        if (sql.includes("from shopify_tracking_outbox")) return { rows: [{ state: "RETRY", status: "IN_TRANSIT", event_at: at }] };
        return { rows: [] };
    } };
    const states = await sync.trackerSyncState(client, 1);
    assert.equal(states.length, 1);
    assert.equal(states[0].state, "RETRY");
    assert.equal(states[0].lastSuccessfulAt, at);
    assert.equal(states[0].lastSuccessfullySentStatus, "CARRIER_PICKED_UP");
});

test("a late scan after published delivery is discarded without calling Shopify", async () => {
    const client = fakeClient(pending);
    const original = client.query;
    client.query = async (sql, params) => sql.startsWith("select id from shopify_tracking_outbox")
        ? { rows: [{ id: 20 }] } : original(sql, params);
    let calls = 0;
    const result = await sync.processOne(client, { request: async () => { calls += 1; } });
    assert.equal(result.state, "DISCARDED");
    assert.equal(calls, 0);
    assert.ok(client.queries.some(({ sql }) => sql.includes("discarded_at=now()")));
    assert.match(client.queries[0].sql, /prior\.discarded_at is null/);
});

test("manual closure prevents queued carrier events from publishing remotely", async () => {
    const client = fakeClient(pending);
    const original = client.query;
    client.query = async (sql, params) => sql.startsWith("select t.id from shopify_tracking_packages")
        ? { rows: [{ id: 4 }] } : original(sql, params);
    let calls = 0;
    assert.equal(await sync.processOne(client, { request: async () => { calls += 1; } }), null);
    assert.equal(calls, 0);
    assert.match(client.queries[0].sql, /t\.manual_closed_at is not null/);
});

test("an invalidated original delivery timestamp is never sent or replayed", async () => {
    const client = fakeClient({ ...pending, status: "DELIVERED", source_event_id: 10 });
    const original = client.query;
    client.query = async (sql, params) => sql.startsWith("select c.id from shopify_tracking_corrections")
        ? { rows: [{ id: 9 }] } : original(sql, params);
    let calls = 0;
    const result = await sync.processOne(client, { request: async () => { calls += 1; } });
    assert.equal(result.state, "DISCARDED");
    assert.equal(calls, 0);
    const source = fs.readFileSync(require.resolve("./shopify-tracking-sync"), "utf8");
    assert.match(source, /discarded_at is null and state in \('RETRY','BLOCKED'\)/);
    assert.match(source, /e\.event_at>=\$4/);
    assert.match(source, /sent\.status='DELIVERED' or sent\.event_at>\$4/);
});

test("tracking migration upgrades earlier candidate schemas and is repeatable", () => {
    const { newDb, DataType } = require("pg-mem");
    const memory = newDb({ noAstCoverageCheck: true });
    memory.public.registerOperator({ operator: "~", left: DataType.text, right: DataType.text,
        returns: DataType.bool, implementation: (value, pattern) => new RegExp(pattern).test(value) });
    memory.public.registerFunction({ name: "jsonb_typeof", args: [DataType.jsonb], returns: DataType.text,
        implementation: (value) => Array.isArray(value) ? "array" : typeof value });
    memory.public.registerFunction({ name: "jsonb_array_length", args: [DataType.jsonb], returns: DataType.integer,
        implementation: (value) => value.length });
    for (const table of ["store_integrations", "portal_orders", "fulfillment_locations", "warehouse_shipments", "shipment_trackers", "shipment_tracking_events"]) {
        memory.public.none(`create table ${table} (id bigserial primary key)`);
    }
    const migration = fs.readFileSync(require("node:path").join(__dirname, "migrations/20260917_shopify_tracking_sync.sql"), "utf8");
    const newColumns = ["shopify_store_gid", "shopify_store_name", "shipped_notifications_enqueued_at", "shopify_notification_state", "discarded_at", "notifications_enqueued_at"];
    let previous = migration.replace(/^alter table .*;\r?\n/gm, "");
    for (const name of newColumns) previous = previous.replace(new RegExp(`^    ${name} .*,\\r?\\n`, "gm"), "");
    memory.public.none(previous);
    memory.public.none(migration);
    memory.public.none(migration);
    const columns = memory.public.many("select column_name from information_schema.columns where table_name='shopify_tracking_fulfillments'").map((row) => row.column_name);
    for (const name of newColumns.slice(0, 4)) assert.ok(columns.includes(name), name);
    memory.public.none("insert into store_integrations(id) values(1); insert into portal_orders(id) values(1)");
    memory.public.none(`insert into shopify_tracking_fulfillments(integration_id,store_identifier,account_name,order_id,external_order_id,fulfillment_gid,expected_tracking_numbers)
        values(1,'test.invalid','CODEX PORTAL SYSTEM TEST',1,'1','gid://shopify/Fulfillment/1','[\"TEST-PACKAGE\"]'::jsonb)`);
    const row = memory.public.one("select * from shopify_tracking_fulfillments");
    assert.equal(row.shopify_store_gid, "");
    assert.equal(row.shopify_notification_state, "UNKNOWN");
});

test("schema and integration retain immutable scans, scoped endpoints, no live effects or notification success claim", () => {
    const server = fs.readFileSync(require.resolve("./server"), "utf8");
    const migration = fs.readFileSync(require("node:path").join(__dirname, "migrations/20260917_shopify_tracking_sync.sql"), "utf8");
    assert.match(migration, /unique \(fulfillment_binding_id, fulfillment_gid, status, event_at\)/);
    assert.match(migration, /shopify_send_state = 'UNKNOWN'/);
    assert.match(migration, /notification_state in \('PENDING','REQUESTED'\)/);
    assert.doesNotMatch(migration, /drop table|delete from|update portal_orders/i);
    assert.ok(server.includes('app.post("/api/admin/shipment-trackers/:id/refresh", requireScopedTrackerRefresh'));
    for (const action of ["shopify-resend", "correct"]) {
        assert.ok(server.includes(`app.post("/api/admin/shipment-trackers/:id/${action}", requireWarehouseAdmin()`));
    }
    const scoped = server.slice(server.indexOf("async function requireScopedShipmentTracker"), server.indexOf("async function scopedTrackerResponse"));
    assert.match(scoped, /assertAppUserCustomerWarehouseAccess/);
    assert.match(scoped, /accountName: tracker.account_name, fulfillmentLocationId: tracker.fulfillment_location_id/);
    assert.match(server, /expectedClaim && current\.claimed_by !== expectedClaim/);
    assert.match(server, /shopifyTrackingSync\.bindFulfillment/);
});

test("actual server fulfillment calls honor enrolled notification controls and legacy compatibility", async () => {
    const { createShopifyFulfillmentForImportedOrder } = require("./server");
    const nativeEvents = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
    const reviews = Object.fromEntries(nativeEvents.map((event) => [event, { state: "DISABLED",
        companyId: integration.account_name, storeId: String(integration.id), reviewedAt: "2026-09-16T12:00:00Z",
        reviewedBy: "fixture-reviewer", evidenceRef: "isolated-config-fixture" }]));
    const baseSettings = { enabled: true, mode: "SHOPIFY", events: nativeEvents, shopifyNativeEvents: reviews };
    const cases = [
        { name: "Shopify enabled", notifications: baseSettings, expected: true },
        { name: "Both enabled", notifications: { ...baseSettings, mode: "BOTH" }, expected: true },
        { name: "WMS only", notifications: { ...baseSettings, mode: "WMS365" }, expected: false },
        { name: "Notifications disabled", notifications: { ...baseSettings, enabled: false }, expected: false },
        { name: "SHIPPED excluded", notifications: { ...baseSettings, events: ["OUT_FOR_DELIVERY", "DELIVERED"] }, expected: false },
        { name: "Native SHIPPED explicitly disabled", notifications: baseSettings, notifyCustomer: false, expected: false },
        { name: "Nonenrolled legacy default", notifications: { ...baseSettings, enabled: false }, enrolled: false, expected: true },
        { name: "Nonenrolled legacy opt out", notifications: baseSettings, enrolled: false, notifyCustomer: false, expected: false }
    ];
    const originalFetch = global.fetch;
    try {
        for (const fixture of cases) {
            const requests = [];
            global.fetch = async (url, options) => {
                url = String(url);
                requests.push({ url, options });
                if (url.endsWith("/fulfillment_orders.json")) return new Response(JSON.stringify({ fulfillment_orders: [
                    { id: 123, status: "open", line_items: [{ quantity: 1 }] }
                ] }), { status: 200 });
                assert.ok(url.endsWith("/fulfillments.json"));
                return new Response(JSON.stringify({ fulfillment: { id: 88 } }), { status: 200 });
            };
            let settingsReads = 0;
            const row = { ...integration, provider: "SHOPIFY", access_token: "isolated-token-fixture",
                settings: { carrierFulfillmentEventsEnabled: fixture.enrolled !== false,
                    ...(fixture.notifyCustomer !== undefined ? { notifyCustomerOnFulfillment: fixture.notifyCustomer } : {}) } };
            const result = await createShopifyFulfillmentForImportedOrder(row, { id: 100, orderCode: "TEST-ORDER",
                shippedTrackingReference: "TEST-PACKAGE", shippedCarrierName: "Canpar" }, "99", {
                getNotificationSettings: async (scope) => {
                    settingsReads += 1;
                    assert.equal(scope.integrationId, integration.id);
                    assert.equal(scope.accountName, integration.account_name);
                    return fixture.notifications;
                }
            });
            assert.equal(requests.length, 2, fixture.name);
            assert.equal(JSON.parse(requests[1].options.body).fulfillment.notify_customer, fixture.expected, fixture.name);
            assert.equal(result.notifyCustomerRequested, fixture.expected, fixture.name);
            assert.equal(settingsReads, fixture.enrolled === false ? 0 : 1, fixture.name);
        }
    } finally { global.fetch = originalFetch; }
});

test("actual server fulfillment rejects missing or cross-store native-disable reviews before mutation", async () => {
    const { createShopifyFulfillmentForImportedOrder, assertShopifyNativeNotificationConfiguration } = require("./server");
    const nativeEvents = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
    const reviews = Object.fromEntries(nativeEvents.map((event) => [event, { state: "DISABLED",
        companyId: integration.account_name, storeId: String(integration.id), reviewedAt: "2026-09-16T12:00:00Z",
        reviewedBy: "fixture-reviewer", evidenceRef: "isolated-config-fixture" }]));
    const base = { enabled: true, mode: "WMS365", events: nativeEvents, shopifyNativeEvents: reviews };
    const invalid = [undefined, { ...reviews.SHIPPED, state: "ENABLED" }, { ...reviews.SHIPPED, companyId: "OTHER COMPANY" },
        { ...reviews.SHIPPED, storeId: "999" }, { ...reviews.SHIPPED, evidenceRef: "" },
        { ...reviews.SHIPPED, reviewedAt: "invalid" }, { ...reviews.SHIPPED, reviewedAt: "2999-01-01T00:00:00Z" }];
    const originalFetch = global.fetch;
    try {
        for (const badReview of invalid) {
            let mutations = 0;
            global.fetch = async (url, options) => {
                url = String(url);
                if (options.method === "POST") mutations += 1;
                assert.ok(url.endsWith("/fulfillment_orders.json"));
                return new Response(JSON.stringify({ fulfillment_orders: [{ id: 123, status: "open" }] }), { status: 200 });
            };
            const notifications = { ...base, shopifyNativeEvents: { ...reviews, SHIPPED: badReview } };
            await assert.rejects(createShopifyFulfillmentForImportedOrder({ ...integration, access_token: "isolated-token-fixture" },
                { orderCode: "TEST-ORDER" }, "99", { getNotificationSettings: async () => notifications }),
                (error) => error.statusCode === 409 && /SHIPPED.*DISABLED review/.test(error.message));
            assert.equal(mutations, 0);
        }
    } finally { global.fetch = originalFetch; }
    assert.throws(() => assertShopifyNativeNotificationConfiguration(integration,
        { enabled: false, mode: "SHOPIFY", events: [], shopifyNativeEvents: {} }, true),
        /SHIPPED, OUT_FOR_DELIVERY, DELIVERED/);
    assert.doesNotThrow(() => assertShopifyNativeNotificationConfiguration(integration, base, true));
    assert.doesNotThrow(() => assertShopifyNativeNotificationConfiguration(integration, { enabled: false }, false));
    const server = fs.readFileSync(require.resolve("./server"), "utf8");
    assert.match(server, /assertShopifyNativeNotificationConfiguration\(integration, notifications, trackingSettings\.carrierFulfillmentEventsEnabled\)/);
    assert.match(server, /shopInfo\.notificationRequested = result\.notifyCustomerRequested === true/);
});

test("server handoffs preserve carrier ETA and Shopify buyer order number, never the WMS code", async () => {
    const { enqueueShopifyDeliveryForCarrierRow, enqueueShopifyShippedNotifications } = require("./server");
    const captured = [];
    const enqueue = async (input) => { captured.push(input); return {}; };
    const row = { integration_id: 3, account_name: binding.account_name, order_id: 100,
        warehouse_shipment_id: 30, fulfillment_location_id: 20, tracking_number: "PACKAGE-A", carrier_name: "Canpar",
        recipient_email: "buyer@example.invalid", order_code: "WMS-ONLY-100", shopify_order_number: "#5011",
        external_order_id: "99", status: "IN_TRANSIT", event_at: at, estimated_delivery_at: "2026-09-19T12:00:00Z" };
    await enqueueShopifyDeliveryForCarrierRow(row, "UNKNOWN", { enqueue });
    assert.equal(captured[0].shipment.orderNumber, "#5011");
    assert.equal(captured[0].event.estimatedDelivery, row.estimated_delivery_at);
    await enqueueShopifyDeliveryForCarrierRow({ ...row, shopify_order_number: "" }, "UNKNOWN", { enqueue });
    assert.equal(captured[1].shipment.orderNumber, "99");
    for (const shopifyOrderNumber of ["#5011", ""]) {
        const client = { async query(sql) { return { rows: sql.startsWith("select * from shopify_tracking_fulfillments")
            ? [{ ...binding }] : sql.startsWith("select t.*") ? [{ ...row, shopify_order_number: shopifyOrderNumber }] : [] }; } };
        await enqueueShopifyShippedNotifications(client, binding.id, { enqueue });
        assert.equal(captured.at(-1).shipment.orderNumber, shopifyOrderNumber || "99");
    }
    const server = fs.readFileSync(require.resolve("./server"), "utf8");
    assert.match(server, /t\.tracking_url,t\.estimated_delivery_at/);
    assert.match(server, /normalizeFreeText\(order\.name \|\| ""\)/);
    const migration = fs.readFileSync(require("node:path").join(__dirname, "migrations/20260917_shopify_tracking_sync.sql"), "utf8");
    assert.match(migration, /add column if not exists shopify_order_number/);
});

test("native requested and deferred log origin is Shopify, while actual WMS attempts stay distinct", () => {
    const { mapShopifyDeliveryNotificationLog: map } = require("./server");
    const requested = { id: 1, integration_id: 3, status: "SUPPRESSED", shopify_send_state: "REQUESTED", delivery_mode: "BOTH" };
    assert.equal(map(requested).origin, "SHOPIFY");
    assert.equal(map(requested).provider, "SHOPIFY");
    assert.equal(map(requested).result, "SUPPRESSED");
    assert.equal(map(requested).sentAt, null);
    assert.equal(map({ ...requested, status: "DEFERRED", shopify_send_state: "UNKNOWN", delivery_mode: "SHOPIFY" }).origin, "SHOPIFY");
    for (const extra of [{ provider_id: "fixture-provider" }, { provider_message_id: "receipt" },
        { claim_token: "claim" }, { attempts: 1 }]) {
        assert.equal(map({ ...requested, ...extra }).origin, "WMS365");
        assert.equal(map({ ...requested, ...extra }).shopifySendState, "REQUESTED");
    }
});

function notificationEvidenceDatabase() {
    const state = { job: null, invalidated: false, bindingLocked: false, transactionOpen: false, queries: [],
        bindingOverrides: {}, otherPackageClosed: false };
    const deliveredPackages = ["PACKAGE-A", "PACKAGE-B"].map((number, index) => ({ tracker_id: index + 1,
        tracking_number: number, current_tracking_number: number, fulfillment_location_id: 20,
        warehouse_shipment_id: index + 30, confirmed_delivered_at: at, delivery_event_id: index + 10,
        shipment_status: "SHIPPED", delivery_status: "DELIVERED", delivery_source: "AFTERSHIP",
        delivery_event_at: at, delivery_safe_metadata: { carrier_scan: true }, delivery_invalidated: false }));
    return { state, async connect() { return { release() {}, async query(sql, p = []) {
        const query = sql.replace(/\s+/g, " ").trim();
        state.queries.push({ sql: query, params: p });
        if (query === "BEGIN") { state.transactionOpen = true; return { rows: [] }; }
        if (query === "COMMIT" || query === "ROLLBACK") { state.transactionOpen = false; state.bindingLocked = false; return { rows: [] }; }
        if (query.startsWith("SELECT id, account_name, provider")) return { rows: [{ ...integration, provider: "SHOPIFY" }] };
        if (query.startsWith("SELECT * FROM shopify_delivery_notification_settings")) return { rows: [{ enabled: true,
            delivery_mode: "WMS365", enabled_events: ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"], sms_enabled: false }] };
        if (query.startsWith("SELECT * FROM shopify_delivery_notification_native_reviews")) return { rows: ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].map((event_type) => ({
            integration_id: 3, account_name: binding.account_name, event_type, configuration_state: "DISABLED",
            reviewed_at: "2026-09-16T12:00:00Z", reviewed_by: "fixture-reviewer", evidence_ref: "fixture-review" })) };
        if (query.startsWith("INSERT INTO shopify_delivery_notification_outbox")) {
            state.job = { id: 1, integration_id: p[0], account_name: p[1], warehouse_id: p[2], order_id: p[3],
                shipment_id: p[4], event_type: p[5], delivery_mode: p[6], channel: p[7], recipient: p[8],
                provenance: JSON.parse(p[10]), payload: JSON.parse(p[11]), shopify_send_state: p[12], dedup_key: p[13], status: p[14] };
            return { rows: [{ id: 1, status: p[14] }] };
        }
        if (query.includes("outcome_code = 'STALE_CLAIM'")) return { rows: [] };
        if (query.startsWith("SELECT o.*")) return { rows: state.job?.status === "PENDING" ? [{ ...state.job }] : [] };
        if (query.includes("attempts = attempts + 1")) { Object.assign(state.job, { status: "SENDING", claim_token: p[2] }); return { rows: [] }; }
        if (query.startsWith("SELECT id FROM shopify_delivery_notification_outbox")) return { rows: [{ id: 1 }] };
        if (query.startsWith("select f.*")) {
            assert.equal(state.transactionOpen, true);
            assert.match(query, /for share of f$/);
            assert.deepEqual(p.slice(0, 3), [3, binding.account_name, "100"]);
            state.bindingLocked = true;
            return { rows: [{ ...binding, order_id: 100, integration_settings: integration.settings, ...state.bindingOverrides }] };
        }
        if (query.startsWith("select p.*")) return { rows: deliveredPackages.map((item, index) => ({ ...item,
            ...(state.otherPackageClosed && index === 1 ? { manual_closed_at: at } : {}),
            ...(state.invalidated && index === 0 ? { confirmed_delivered_at: null, delivery_event_id: null, delivery_invalidated: true } : {}) })) };
        if (query.startsWith("select ob.*")) return { rows: [{ id: 50, tracker_id: 1, remote_event_gid: "gid://shopify/FulfillmentEvent/5",
            event_at: at, status: "DELIVERED", carrier_status: "DELIVERED", source: "AFTERSHIP",
            safe_metadata: { carrier_scan: true }, carrier_event_at: at, invalidated: state.invalidated }] };
        if (query.includes("SET status = $3")) { Object.assign(state.job, { status: p[2], outcome_code: p[3], provider_message_id: p[4] });
            return { rows: [{ id: 1, status: p[2] }] }; }
        throw new Error(`Unhandled fixture query: ${query}`);
    } }; } };
}

test("actual notification worker suppresses delivery invalidated after enqueue and holds binding lock during valid send", async () => {
    const service = require("./shopify-delivery-notification-service");
    const { validateShopifyDeliveryNotificationEvent } = require("./server");
    for (const invalidated of [true, false]) {
        const db = notificationEvidenceDatabase();
        await service.enqueueDeliveryNotifications({ db, integrationId: 3, accountName: binding.account_name,
            shipment: { companyId: binding.account_name, storeId: "3", warehouseId: "20", orderId: "100", id: "30",
                orderNumber: "#5011", carrier: "Canpar", trackingNumber: "PACKAGE-A", trackingUrl: "https://example.invalid/track" },
            event: { status: "DELIVERED", eventAt: at, description: "Isolated delivered scan" },
            recipient: { email: "buyer@example.invalid", smsConsent: false }, shopifySendState: "UNKNOWN",
            provenance: { sourceType: "CARRIER_SCAN", sourceRef: "50", shopifyEvidenceRef: "gid://shopify/FulfillmentEvent/5" } });
        assert.equal(db.state.job.status, "PENDING");
        db.state.invalidated = invalidated;
        let sends = 0;
        const outcomes = await service.runDeliveryNotificationWorker({ db, limit: 1,
            validateEvent: validateShopifyDeliveryNotificationEvent,
            provider: { id: "isolated-provider", emailConfigured: true, supportsIdempotency: false, async sendEMAIL() {
                assert.equal(db.state.transactionOpen, true);
                assert.equal(db.state.bindingLocked, true);
                sends += 1;
                return { state: "SENT", messageId: "isolated-receipt" };
            } } });
        assert.equal(sends, invalidated ? 0 : 1);
        assert.equal(outcomes[0].status, invalidated ? "SUPPRESSED" : "SENT");
        assert.equal(db.state.job.outcome_code, invalidated ? "DELIVERY_EVIDENCE_UNVERIFIED" : "PROVIDER_CONFIRMED");
        assert.equal(db.state.bindingLocked, false);
    }
    const server = fs.readFileSync(require.resolve("./server"), "utf8");
    assert.match(server, /resolveRecipient: getCurrentShopifyDeliveryRecipient, validateEvent: validateShopifyDeliveryNotificationEvent/);
    const handoff = server.slice(server.indexOf("async function runShopifyDeliveryNotificationHandoff"), server.indexOf("async function enqueueShopifyDeliveryForCarrierRow"));
    assert.match(handoff, /ob\.discarded_at is null/);
    assert.match(handoff, /correction\.action='INVALIDATE_DELIVERY'/);
    assert.match(handoff, /jsonb_array_length\(f\.expected_tracking_numbers\)/);
});

test("send-time delivery evidence rejects disabled, expired, nonenrolled and other-package manual closure", async () => {
    const { validateShopifyDeliveryNotificationEvent } = require("./server");
    for (const overrides of [{ enrolled_at: null }, { integration_settings: {} }, { expires_at: "2020-01-01T00:00:00Z" },
        { expires_at: "invalid" }, { otherPackageClosed: true }]) {
        const db = notificationEvidenceDatabase();
        db.state.bindingOverrides = overrides;
        db.state.otherPackageClosed = overrides.otherPackageClosed === true;
        const client = await db.connect();
        await client.query("BEGIN");
        assert.equal(await validateShopifyDeliveryNotificationEvent({ client, row: {
            integration_id: 3, account_name: binding.account_name, order_id: "100", warehouse_id: "20", shipment_id: "30",
            event_type: "DELIVERED", payload: { shipment: { trackingNumber: "PACKAGE-A" }, event: { eventAt: at } },
            provenance: { sourceType: "CARRIER_SCAN", sourceRef: "50", shopifyEvidenceRef: "gid://shopify/FulfillmentEvent/5" }
        } }), false);
        await client.query("ROLLBACK");
    }
});
