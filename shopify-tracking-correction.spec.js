"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { correction, SQL, targetInfo } = require("./shopify-tracking-correction");

test("correction route owns a dedicated connection, reauthorizes and disables mutation retries", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const start = server.indexOf('app.post("/api/admin/shipment-trackers/:id/correct"');
    const branch = server.slice(start, server.indexOf("const tracker = await withTransaction", start));
    assert.match(branch, /requireWarehouseAdmin\(\)/);
    assert.match(branch, /const client = await pool\.connect\(\)/);
    assert.match(branch, /requireScopedShipmentTracker\(client, req\)/);
    assert.match(branch, /shopifyTrackingCorrection\.correction\(client, current/);
    assert.match(branch, /assertAppUserCustomerWarehouseAccess/);
    assert.match(branch, /STORE_INTEGRATIONS/);
    assert.match(branch, /SHOPIFY_INTEGRATION/);
    assert.match(branch, /retryAuthorization: false/);
    assert.match(branch, /trackingRuntimeAvailable: Boolean\(AFTERSHIP_TRACKING_API_KEY\)/);
    assert.match(branch, /finally \{ client\.release\(\); \}/);
    assert.doesNotMatch(branch, /withTransaction\(/);
    const sync = fs.readFileSync(path.join(__dirname, "shopify-tracking-sync.js"), "utf8");
    const watermark = sync.slice(sync.indexOf("async function insertOutbox"), sync.indexOf("async function queueTrackerEvents"));
    assert.match(watermark, /current_package\.tracker_id=evidence\.tracker_id/);
    assert.match(watermark, /evidence\.id=sent\.source_event_id/);
});

function fixture(overrides = {}) {
    const tracker = { id: "11", account_name: "TEST COMPANY", order_id: "22", fulfillment_location_id: "33",
        warehouse_shipment_id: "44", tracking_number: "TEST-OLD", tracking_url: "https://www.canpar.com/en/tracking/track.htm?barcode=TEST-OLD",
        carrier_key: "CANPAR", carrier_name: "Canpar", status: "IN_TRANSIT", provider_key: "AFTERSHIP",
        provider_tracker_id: "old-provider-identity", manual_closed_at: null, is_active: true, claimed_at: null, claimed_by: "" };
    const binding = { id: "55", integration_id: "66", account_name: tracker.account_name, order_id: tracker.order_id,
        external_order_id: "77", store_identifier: "test-only.myshopify.com", shopify_store_gid: "gid://shopify/Shop/88",
        fulfillment_gid: "gid://shopify/Fulfillment/99", expected_tracking_numbers: [tracker.tracking_number],
        enrolled_at: "2026-09-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", tracking_started_at: "2026-09-01T00:00:00Z" };
    const pkg = { id: "100", tracker_id: tracker.id, fulfillment_binding_id: binding.id, package_id: tracker.id,
        account_name: tracker.account_name, order_id: tracker.order_id, fulfillment_location_id: tracker.fulfillment_location_id,
        warehouse_shipment_id: tracker.warehouse_shipment_id, tracking_number: tracker.tracking_number,
        confirmed_delivered_at: null, delivery_event_id: null };
    return { tracker, trackers: [tracker], binding, packages: [pkg],
        store: { id: binding.integration_id, account_name: tracker.account_name, store_identifier: binding.store_identifier,
            provider: "SHOPIFY", is_active: true, settings: { carrierFulfillmentEventsEnabled: true }, encrypted_credentials: "test-encrypted" },
        shipment: { id: tracker.warehouse_shipment_id, account_name: tracker.account_name, order_id: tracker.order_id,
            fulfillment_location_id: tracker.fulfillment_location_id, status: "SHIPPED", shipment_method: "PARCEL",
            package_count: 1, tracking_reference: tracker.tracking_number, carrier_name: "Canpar" },
        order: { id: tracker.order_id, account_name: tracker.account_name, shipped_tracking_reference: tracker.tracking_number },
        events: [{ id: "101", tracker_id: tracker.id, status: "IN_TRANSIT", event_at: "2026-09-16T12:00:00Z" }],
        outbox: [{ id: "102", state: "PENDING", source_event_id: "101", discarded_at: null },
            { id: "103", state: "SENT", source_event_id: "101", discarded_at: null }],
        audits: [], evidence: [], notifications: [], matches: 1, shipmentCount: 1, imported: true, locked: true, ...overrides };
}
function fakeClient(initial = fixture()) {
    let state = structuredClone(initial);
    let backup;
    const calls = [];
    const writes = [];
    const rows = (items) => ({ rows: structuredClone(items), rowCount: items.length });
    const client = { calls, writes, get state() { return state; }, async query(sql, params = []) {
        calls.push({ sql, params: structuredClone(params) });
        if (sql === "begin") { assert.equal(backup, undefined, "no nested transactions"); backup = structuredClone(state); return rows([]); }
        if (sql === "commit") { backup = undefined; return rows([]); }
        if (sql === "rollback") { if (backup) state = backup; backup = undefined; return rows([]); }
        if (sql.startsWith("set local")) return rows([]);
        if (sql === SQL.transactionState) return rows([{ already_in_transaction: Boolean(backup) }]);
        if (sql === SQL.tracker) return rows(state.trackers.filter((t) => [t.id, t.account_name, t.order_id, t.fulfillment_location_id, t.warehouse_shipment_id]
            .every((value, index) => String(value) === String(params[index]))));
        if (sql.includes("select f.*, p.id as binding_package_id")) return rows(state.packages.some((p) => p.tracker_id === params[0])
            ? Array.from({ length: state.matches }, () => state.binding) : []);
        if (sql === SQL.advisory) return rows([{ locked: state.locked }]);
        if (sql === SQL.binding) return rows([state.binding].filter((b) => [b.id, b.account_name, b.order_id, b.integration_id, b.store_identifier]
            .every((value, index) => String(value) === String(params[index]))));
        if (sql === SQL.store) return rows([state.store].filter((i) => i.provider === "SHOPIFY" && [i.id, i.account_name, i.store_identifier]
            .every((value, index) => String(value) === String(params[index]))));
        if (sql === SQL.packages) return rows(state.packages.filter((p) => p.fulfillment_binding_id === params[0]));
        if (sql === SQL.trackerPackages) return rows(state.packages.filter((p) => p.tracker_id === params[0]));
        if (sql === SQL.shipment) return rows([state.shipment].filter((s) => [s.id, s.account_name, s.order_id, s.fulfillment_location_id]
            .every((value, index) => String(value) === String(params[index]))));
        if (sql === SQL.order) return rows([state.order].filter((o) => o.id === params[0] && o.account_name === params[1]));
        if (sql === SQL.shipmentCount) return rows(Array.from({ length: state.shipmentCount }, (_, index) => ({ id: index ? "999" : state.shipment.id })));
        if (sql === SQL.imported) return rows(state.imported ? [{ id: "200" }] : []);
        if (sql === SQL.evidence) return rows(state.evidence);
        if (sql === SQL.notifications) return rows(state.notifications);
        if (sql === SQL.pendingOutbox) return rows(state.outbox.filter((ob) => ob.state !== "SENT" && !ob.discarded_at)
            .map((ob) => ({ ...ob, tracker_id: state.events.find((e) => e.id === ob.source_event_id)?.tracker_id })));
        if (sql === SQL.collision) return rows(state.trackers.filter((t) => t.account_name === params[0] && t.order_id === params[1] && t.tracking_number === params[2]));
        if (sql === SQL.auditRead) return rows(state.audits.filter((a) => a.tracker_id === params[0] && a.fulfillment_binding_id === params[1]).toReversed());
        writes.push({ sql, params: structuredClone(params) });
        if (sql === SQL.audit) {
            const audit = { id: String(300 + state.audits.length), fulfillment_binding_id: params[0], tracker_id: params[1], actor: params[2], reason: params[3], action: "MANUAL_CLOSE" };
            state.audits.push(audit); return rows([audit]);
        }
        if (sql === SQL.close) { state.tracker.manual_closed_at = "2026-09-17T12:00:00Z"; state.tracker.is_active = false; state.tracker.next_poll_at = null; return rows([{ id: params[0] }]); }
        if (sql === SQL.discard) {
            for (const item of state.outbox) if (item.state !== "SENT" && !item.discarded_at && state.events.some((e) => e.id === item.source_event_id && e.tracker_id === params[2])) {
                item.discarded_at = "2026-09-17T12:00:00Z"; item.state = "BLOCKED";
            }
            return rows([]);
        }
        if (sql === SQL.newTracker) {
            const fresh = { id: "500", warehouse_shipment_id: params[0], order_id: params[1], account_name: params[2], fulfillment_location_id: params[3],
                carrier_key: params[4], carrier_name: params[5], carrier_slug: params[6], tracking_number: params[7], tracking_url: params[8],
                provider_key: "AFTERSHIP", provider_tracker_id: "", status: "PENDING", is_active: params[9] };
            state.trackers.push(fresh); return rows([fresh]);
        }
        if (sql === SQL.rebind) { Object.assign(state.packages[0], { tracker_id: params[1], package_id: params[1], tracking_number: params[2], confirmed_delivered_at: null, delivery_event_id: null }); return rows([{ id: params[0] }]); }
        if (sql === SQL.expected) { state.binding.expected_tracking_numbers = JSON.parse(params[1]); return rows([{ id: params[0] }]); }
        if (sql === SQL.updateShipment) { state.shipment.tracking_reference = params[1]; state.shipment.carrier_name = params[2]; return rows([{ id: params[0] }]); }
        if (sql === SQL.updateOrder) { state.order.shipped_tracking_reference = params[1]; state.order.shipped_carrier_name = params[2]; return rows([{ id: params[0] }]); }
        throw new Error(`Unexpected mock SQL: ${sql}`);
    } };
    return client;
}
function remoteFixture(state) {
    return { shop: { id: state.binding.shopify_store_gid, myshopifyDomain: state.binding.store_identifier },
        fulfillment: { id: state.binding.fulfillment_gid, order: { id: "gid://shopify/Order/77" },
            status: "SUCCESS", displayStatus: "IN_TRANSIT", deliveredAt: null,
            trackingInfo: [{ number: state.tracker.tracking_number, company: "Canpar", url: state.tracker.tracking_url }],
            events: { nodes: [{ status: "IN_TRANSIT" }], pageInfo: { hasNextPage: false } } } };
}
function fakeRemote(client, { timeout = false, accept = true, initialChange, afterSendChange, readFailure = 0 } = {}) {
    const data = remoteFixture(client.state);
    if (initialChange) initialChange(data);
    const calls = [];
    let reads = 0;
    return { calls, data, async request(integration, route, options) {
        assert.equal(integration.id, "66");
        assert.equal(integration.decrypted, true);
        assert.equal(route, "/graphql.json");
        const mutation = options.body.query.includes("fulfillmentTrackingInfoUpdate");
        calls.push({ mutation, query: options.body.query, variables: options.body.variables, committedIntent: client.calls.filter((c) => c.sql === "commit").length });
        if (!mutation) {
            reads++;
            if (reads === readFailure) throw new Error("remote read timeout; secret token must not leak");
            return { payload: { data: structuredClone(data) } };
        }
        assert.ok(client.state.tracker.manual_closed_at, "old tracker paused before send");
        assert.ok(calls.at(-1).committedIntent >= 1, "intent committed before send");
        if (accept) data.fulfillment.trackingInfo = [structuredClone(options.body.variables.tracking)];
        if (afterSendChange) afterSendChange(data);
        if (timeout) throw new Error("ambiguous write timeout: private token");
        return { payload: { data: { fulfillmentTrackingInfoUpdate: { fulfillment: { id: data.fulfillment.id }, userErrors: accept ? [] : [{ message: "denied" }] } } } };
    } };
}
const INPUT = { carrier: "ICS Courier", trackingNumber: "TEST-NEW", reason: "Correct the carrier label reference" };
function options(remote, extra = {}) {
    return { request: remote.request, decrypt: async (store) => ({ ...store, decrypted: true }), actor: "TEST ADMIN",
        assertFeatures: async (client, account, store) => { assert.equal(account, "TEST COMPANY"); assert.equal(store.id, "66"); }, ...extra };
}

test("static SQL locks every ownership boundary and preserves immutable history", () => {
    for (const sql of [SQL.tracker, SQL.binding, SQL.store, SQL.shipment, SQL.order]) {
        assert.match(sql, /account_name=\$/);
        assert.match(sql, /for update/);
    }
    assert.match(SQL.tracker, /fulfillment_location_id=\$4 and warehouse_shipment_id=\$5/);
    assert.match(SQL.store, /store_identifier=\$3[\s\S]*provider='SHOPIFY'/);
    assert.match(SQL.advisory, /pg_try_advisory_xact_lock[\s\S]*shopify-tracking/);
    assert.match(SQL.imported, /integration_id=\$1[\s\S]*portal_order_id=\$2[\s\S]*external_order_id=\$3/);
    assert.match(SQL.discard, /discarded_at=now\(\)[\s\S]*state<>'SENT'[\s\S]*source_event_id[\s\S]*tracker_id=\$3/);
    assert.match(SQL.newTracker, /insert into shipment_trackers/);
    assert.doesNotMatch(SQL.newTracker, /on conflict|provider_tracker_id\s*=|event_at/i);
    assert.match(SQL.rebind, /tracker_id=\$2,package_id=\$2::text/);
    assert.match(SQL.rebind, /tracker_id=\$4[\s\S]*account_name=\$6[\s\S]*fulfillment_location_id=\$8/);
    for (const sql of Object.values(SQL)) assert.doesNotMatch(sql, /(?:update|delete from) shipment_tracking_events|delete from|alter table/i);
    const migration = fs.readFileSync(path.join(__dirname, "migrations", "20260917_shopify_tracking_sync.sql"), "utf8");
    assert.match(migration, /'MANUAL_CLOSE'/);
    assert.match(SQL.audit, /'MANUAL_CLOSE'/);
});

for (const [carrier, company, urlPart, slug] of [["Canpar Express", "Canpar", "canpar.com/en/tracking/track.htm?barcode=", "canpar"],
    ["ICS", "ICS Courier", "icscourier.ca/online-services/parcel-tracking.aspx?trackNums=", "icscourier"],
    ["GLS Canada", "GLS", "ship.gls-canada.com/tracking/", "dicom"]]) {
    test(`${company} accepted correction creates a new tracker without replaying old evidence`, async () => {
        const client = fakeClient();
        const remote = fakeRemote(client);
        const oldEvents = structuredClone(client.state.events);
        const oldIdentity = structuredClone(client.state.tracker);
        const result = await correction(client, oldIdentity, { ...INPUT, carrier }, options(remote));
        assert.equal(result.status, "CORRECTED");
        assert.equal(result.trackerId, "500");
        assert.equal(result.needsManualReconcile, false);
        const fresh = client.state.trackers[1];
        assert.equal(fresh.carrier_name, company);
        assert.equal(fresh.carrier_slug, slug);
        assert.equal(fresh.provider_tracker_id, "");
        assert.equal(fresh.status, "PENDING");
        assert.equal(fresh.is_active, false, "runtime activation defaults OFF even for enrolled bindings");
        assert.ok(fresh.tracking_url.includes(urlPart));
        assert.equal(client.state.tracker.tracking_number, oldIdentity.tracking_number);
        assert.equal(client.state.tracker.provider_tracker_id, oldIdentity.provider_tracker_id);
        assert.ok(client.state.tracker.manual_closed_at);
        assert.deepEqual(client.state.events, oldEvents);
        assert.equal(client.state.packages[0].tracker_id, "500");
        assert.equal(client.state.packages[0].package_id, "500");
        assert.deepEqual(client.state.binding.expected_tracking_numbers, [INPUT.trackingNumber]);
        assert.equal(client.state.binding.tracking_started_at, "2026-09-01T00:00:00Z");
        assert.equal(client.state.shipment.tracking_reference, INPUT.trackingNumber);
        assert.equal(client.state.order.shipped_tracking_reference, INPUT.trackingNumber);
        assert.ok(client.state.outbox[0].discarded_at);
        assert.equal(client.state.outbox[1].state, "SENT");
        assert.equal(client.state.outbox[1].discarded_at, null);
        const audits = client.state.audits.map((a) => JSON.parse(a.reason));
        assert.equal(audits[0].phase, "PREPARED");
        assert.equal(audits[1].phase, "APPLIED");
        assert.equal(audits[1].newTrackerId, "500");
        assert.equal(audits[0].userReason, INPUT.reason);
        assert.equal(remote.calls.filter((c) => c.mutation).length, 1);
        assert.match(remote.calls.find((c) => c.mutation).query, /notifyCustomer:false/);
        assert.equal(client.calls.filter((c) => c.sql === "commit").length, 2);
    });
}

test("mutation timeout reconciles an accepted write instead of sending twice", async () => {
    const client = fakeClient();
    const remote = fakeRemote(client, { timeout: true });
    const result = await correction(client, structuredClone(client.state.tracker), INPUT, options(remote));
    assert.equal(result.status, "CORRECTED");
    assert.equal(remote.calls.filter((c) => c.mutation).length, 1);
    assert.equal(remote.calls.filter((c) => !c.mutation).length, 3);
});

test("tracker activation requires an explicit boolean runtime capability after the feature gate", async () => {
    for (const trackingRuntimeAvailable of [false, true]) {
        const client = fakeClient(); const remote = fakeRemote(client);
        let checked = false;
        const result = await correction(client, structuredClone(client.state.tracker), INPUT, options(remote, {
            trackingRuntimeAvailable,
            assertFeatures: async () => { checked = true; }
        }));
        assert.equal(result.status, "CORRECTED");
        assert.equal(checked, true);
        assert.equal(client.state.trackers[1].is_active, trackingRuntimeAvailable);
    }
    const client = fakeClient(); const remote = fakeRemote(client);
    await assert.rejects(correction(client, client.state.tracker, INPUT, options(remote, { trackingRuntimeAvailable: "true" })),
        { code: "invalid_runtime_activation_flag" });
    assert.equal(client.calls.length, 0);
});

test("ambiguous unchanged remote requires manual reconciliation and never retries the mutation", async () => {
    const client = fakeClient();
    const supplied = structuredClone(client.state.tracker);
    const remote = fakeRemote(client, { timeout: true, accept: false });
    const first = await correction(client, supplied, INPUT, options(remote));
    assert.equal(first.status, "NEEDS_MANUAL_RECONCILE");
    assert.equal(first.needsManualReconcile, true);
    assert.equal(client.state.trackers.length, 1);
    assert.equal(client.state.packages[0].tracker_id, "11");
    const second = await correction(client, supplied, INPUT, options(remote));
    assert.equal(second.status, "NEEDS_MANUAL_RECONCILE");
    assert.equal(remote.calls.filter((c) => c.mutation).length, 1);
    assert.equal(client.state.audits.length, 1);
    remote.data.fulfillment.trackingInfo = [targetInfo(INPUT, supplied)];
    const recovered = await correction(client, supplied, INPUT, options(remote));
    assert.equal(recovered.status, "CORRECTED");
    assert.equal(remote.calls.filter((c) => c.mutation).length, 1);
});

test("wrong remote order/store/fulfillment and delivered/incomplete responses have no write effects", async () => {
    for (const change of [
        (d) => { d.fulfillment.order.id = "gid://shopify/Order/999"; },
        (d) => { d.shop.myshopifyDomain = "other.myshopify.com"; },
        (d) => { d.shop.id = "gid://shopify/Shop/999"; },
        (d) => { d.fulfillment.id = "gid://shopify/Fulfillment/999"; },
        (d) => { d.fulfillment.displayStatus = "DELIVERED"; },
        (d) => { d.fulfillment.deliveredAt = "2026-09-16T12:00:00Z"; },
        (d) => { d.fulfillment.events.nodes.push({ status: "DELIVERED" }); },
        (d) => { d.fulfillment.events.pageInfo.hasNextPage = true; },
        (d) => { d.fulfillment.trackingInfo.push({ number: "OTHER" }); },
        (d) => { d.fulfillment.trackingInfo[0].number = "REMOTE-DRIFT"; },
        (d) => { d.fulfillment.trackingInfo[0].url = "https://attacker.invalid"; },
        (d) => { d.fulfillment.status = "CANCELLED"; },
        (d) => { delete d.fulfillment.deliveredAt; }
    ]) {
        const client = fakeClient();
        const before = structuredClone(client.state);
        const remote = fakeRemote(client, { initialChange: change });
        const result = await correction(client, before.tracker, INPUT, options(remote));
        assert.equal(result.status, "REJECTED");
        assert.equal(client.writes.length, 0);
        assert.deepEqual(client.state, before);
        assert.equal(remote.calls.filter((c) => c.mutation).length, 0);
    }
});

test("scoped unsupported/delivered/claimed/notification cases reject before any remote call", async () => {
    for (const mutate of [
        (s) => { s.tracker.status = "DELIVERED"; }, (s) => { s.tracker.delivered_at = "2026-09-16"; },
        (s) => { s.packages[0].confirmed_delivered_at = "2026-09-16"; }, (s) => { s.packages[0].delivery_event_id = "101"; },
        (s) => { s.evidence = [{ id: "101" }]; }, (s) => { s.tracker.claimed_by = "worker"; },
        (s) => { s.matches = 2; }, (s) => { s.packages.push({ ...s.packages[0], id: "201" }); },
        (s) => { s.packages[0].account_name = "OTHER COMPANY"; }, (s) => { s.packages[0].fulfillment_location_id = "999"; },
        (s) => { s.binding.expected_tracking_numbers.push("OTHER"); }, (s) => { s.shipment.package_count = 2; },
        (s) => { s.shipmentCount = 2; }, (s) => { s.imported = false; }, (s) => { s.locked = false; },
        (s) => { s.notifications = [{ id: "999" }]; }, (s) => { s.store.is_active = false; },
        (s) => { s.outbox[0].source_event_id = null; },
        (s) => { s.store.account_name = "OTHER COMPANY"; }, (s) => { s.store.settings.carrierFulfillmentEventsEnabled = false; },
        (s) => { s.trackers.push({ ...s.tracker, id: "600", tracking_number: INPUT.trackingNumber }); }
    ]) {
        const state = fixture(); mutate(state);
        const client = fakeClient(state);
        const remote = fakeRemote(client);
        const result = await correction(client, structuredClone(state.tracker), INPUT, options(remote));
        assert.equal(result.status, "REJECTED");
        assert.equal(client.writes.length, 0);
        assert.equal(remote.calls.length, 0);
    }
});

test("feature authorization and stale company/warehouse scope fail with no effects", async () => {
    const client = fakeClient(); const remote = fakeRemote(client);
    for (const supplied of [{ ...client.state.tracker, account_name: "OTHER COMPANY" },
        { ...client.state.tracker, fulfillment_location_id: "999" }, { ...client.state.tracker, order_id: "999" }]) {
        assert.equal((await correction(client, supplied, INPUT, options(remote))).status, "REJECTED");
    }
    const denied = await correction(client, client.state.tracker, INPUT, options(remote, {
        assertFeatures: async () => { throw Object.assign(new Error("feature denied"), { code: "feature_denied" }); } }));
    assert.equal(denied.code, "feature_denied");
    assert.equal(client.writes.length, 0);
    assert.equal(remote.calls.length, 0);
});

test("an enclosing transaction is rejected instead of committing the parent's work", async () => {
    const client = fakeClient(); const remote = fakeRemote(client);
    await client.query("begin");
    await assert.rejects(correction(client, client.state.tracker, INPUT, options(remote)), { code: "enclosing_transaction_unsupported" });
    assert.equal(client.calls.filter((c) => c.sql === "commit").length, 0);
    assert.equal(client.writes.length, 0);
    await client.query("rollback");
});

test("same-number carrier-only changes and invalid input/dependencies reject without effects", async () => {
    const client = fakeClient(); const remote = fakeRemote(client);
    for (const input of [{ ...INPUT, trackingNumber: "TEST-OLD" }, { ...INPUT, carrier: "UPS" },
        { ...INPUT, reason: " " }, { ...INPUT, trackingNumber: "x\ny" }]) {
        await assert.rejects(correction(client, client.state.tracker, input, options(remote)), { statusCode: input.trackingNumber === "TEST-OLD" ? 409 : 400 });
    }
    await assert.rejects(correction(client, client.state.tracker, INPUT, options(remote, { assertFeatures: undefined })), { code: "correction_dependencies_required" });
    assert.equal(client.calls.length, 0);
    assert.equal(remote.calls.length, 0);
});

test("post-send ownership/delivery/read ambiguity never changes the package identity or leaks errors", async () => {
    for (const config of [{ readFailure: 3 },
        { afterSendChange: (d) => { d.fulfillment.order.id = "gid://shopify/Order/999"; } },
        { afterSendChange: (d) => { d.fulfillment.displayStatus = "DELIVERED"; } }]) {
        const client = fakeClient(); const remote = fakeRemote(client, config);
        const result = await correction(client, structuredClone(client.state.tracker), INPUT, options(remote));
        assert.equal(result.status, "NEEDS_MANUAL_RECONCILE");
        assert.equal(client.state.trackers.length, 1);
        assert.equal(client.state.packages[0].tracker_id, "11");
        assert.equal(client.state.audits.length, 1);
        assert.ok(client.state.tracker.manual_closed_at);
        assert.equal(JSON.stringify(result).includes("secret"), false);
        assert.equal(remote.calls.filter((c) => c.mutation).length, 1);
    }
});

test("an uncertain intent commit never authorizes a remote mutation", async () => {
    const client = fakeClient(); const remote = fakeRemote(client);
    const query = client.query.bind(client);
    let failed = false;
    client.query = async (sql, params) => {
        const result = await query(sql, params);
        if (sql === "commit" && !failed) { failed = true; throw new Error("commit acknowledgement lost"); }
        return result;
    };
    const result = await correction(client, structuredClone(client.state.tracker), INPUT, options(remote));
    assert.equal(result.status, "NEEDS_MANUAL_RECONCILE");
    assert.equal(remote.calls.filter((c) => c.mutation).length, 0);
    assert.equal(client.state.audits.length, 1);
    assert.equal(client.state.trackers.length, 1);
});

test("a binding moved to a different store between phases cannot authorize a write", async () => {
    const client = fakeClient(); const remote = fakeRemote(client);
    const query = client.query.bind(client);
    let begins = 0;
    client.query = async (sql, params) => {
        if (sql === "begin" && ++begins === 2) {
            client.state.binding.store_identifier = "other.myshopify.com";
            client.state.store.store_identifier = "other.myshopify.com";
        }
        return query(sql, params);
    };
    const result = await correction(client, structuredClone(client.state.tracker), INPUT, options(remote));
    assert.equal(result.status, "NEEDS_MANUAL_RECONCILE");
    assert.equal(result.code, "correction_intent_scope_changed");
    assert.equal(remote.calls.length, 1);
    assert.equal(client.state.trackers.length, 1);
});

test("local failure after remote acceptance rolls back rebinding and recovers without another mutation", async () => {
    const client = fakeClient(); const remote = fakeRemote(client);
    const supplied = structuredClone(client.state.tracker);
    const query = client.query.bind(client);
    let failOnce = true;
    client.query = async (sql, params) => {
        if (sql === SQL.newTracker && failOnce) { failOnce = false; throw Object.assign(new Error("insert failed"), { code: "23505" }); }
        return query(sql, params);
    };
    const first = await correction(client, supplied, INPUT, options(remote));
    assert.equal(first.status, "NEEDS_MANUAL_RECONCILE");
    assert.equal(client.state.packages[0].tracker_id, "11");
    assert.equal(client.state.trackers.length, 1);
    assert.equal(client.state.audits.length, 1);
    const second = await correction(client, supplied, INPUT, options(remote));
    assert.equal(second.status, "CORRECTED");
    assert.equal(second.trackerId, "500");
    assert.equal(remote.calls.filter((c) => c.mutation).length, 1);
});
