"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    sanitizeSettings, getDeliveryNotificationSettings, setDeliveryNotificationSettings,
    enqueueDeliveryNotifications, recordShopifySendState, runDeliveryNotificationWorker,
    recordShopifyNotificationConfiguration, getDeliveryNotificationCapabilities
} = require("./shopify-delivery-notification-service");

// In-memory transactional query double: no external database or provider is used.
// Lock ownership models SKIP LOCKED; SQL shape is separately asserted below.
function database(settings = { enabled: true, mode: "WMS365" }) {
    const state = { integrations: [{ id: "1", account_name: "TEST-ACCOUNT", provider: "SHOPIFY", is_active: true }],
        settings: new Map(), jobs: [], queries: [], locks: new Map(), nextId: 1,
        reviews: ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].map((event_type) => ({ integration_id: "1",
            account_name: "TEST-ACCOUNT", event_type, configuration_state: "DISABLED",
            reviewed_at: "2026-09-17T10:00:00Z", reviewed_by: "TEST-REVIEWER", evidence_ref: "TEST-REVIEW" })), audit: [] };
    function settingRow(input) {
        const value = sanitizeSettings(input);
        return { enabled: value.enabled, delivery_mode: value.mode, enabled_events: value.events,
            sms_enabled: value.smsEnabled, brand_name: value.brandName, logo_url: value.logoUrl,
            message_template: value.messageTemplate };
    }
    if (settings !== null) state.settings.set("1", settingRow(settings));
    const db = { state, async connect() {
        const owner = Symbol("client");
        const undo = [];
        function releaseLocks() {
            for (const [id, lock] of state.locks) if (lock === owner) state.locks.delete(id);
        }
        function update(row, values) {
            const before = { ...row };
            undo.push(() => Object.assign(row, before));
            Object.assign(row, values);
        }
        return { release: releaseLocks, async query(sql, parameters = []) {
            const query = sql.replace(/\s+/g, " ").trim();
            const p = parameters;
            state.queries.push({ sql: query, parameters: p });
            if (query === "BEGIN") return { rows: [] };
            if (query === "COMMIT") { undo.length = 0; releaseLocks(); return { rows: [] }; }
            if (query === "ROLLBACK") { undo.reverse().forEach((restore) => restore()); releaseLocks(); return { rows: [] }; }
            if (query.startsWith("SELECT id, account_name")) {
                return { rows: state.integrations.filter((row) => String(row.id) === String(p[0]) && row.account_name === p[1]) };
            }
            if (query.startsWith("SELECT * FROM shopify_delivery_notification_settings")) {
                const row = state.settings.get(String(p[0]));
                return { rows: row ? [row] : [] };
            }
            if (query.startsWith("SELECT * FROM shopify_delivery_notification_native_reviews")) {
                return { rows: state.reviews.filter((row) => String(row.integration_id) === String(p[0]) && row.account_name === p[1]) };
            }
            if (query.startsWith("INSERT INTO shopify_delivery_notification_native_reviews")) {
                const before = structuredClone(state.reviews);
                undo.push(() => { state.reviews = before; });
                state.reviews = state.reviews.filter((row) => !(String(row.integration_id) === String(p[0]) && row.account_name === p[1] && row.event_type === p[2]));
                state.reviews.push({ integration_id: p[0], account_name: p[1], event_type: p[2], configuration_state: p[3],
                    reviewed_at: new Date().toISOString(), reviewed_by: p[4], evidence_ref: p[5] });
                return { rows: [] };
            }
            if (query.startsWith("INSERT INTO shopify_delivery_notification_review_audit")) {
                state.audit.push(parameters);
                undo.push(() => state.audit.pop());
                return { rows: [] };
            }
            if (query.startsWith("INSERT INTO shopify_delivery_notification_settings")) {
                state.settings.set(String(p[0]), { enabled: p[1], delivery_mode: p[2], enabled_events: JSON.parse(p[3]),
                    sms_enabled: p[4], brand_name: p[5], logo_url: p[6], message_template: p[7] });
                return { rows: [] };
            }
            if (query.startsWith("INSERT INTO shopify_delivery_notification_outbox")) {
                if (state.jobs.some((row) => String(row.integration_id) === String(p[0]) && row.account_name === p[1] && row.dedup_key === p[13])) return { rows: [] };
                const row = { id: state.nextId++, integration_id: p[0], account_name: p[1], warehouse_id: p[2],
                    order_id: p[3], shipment_id: p[4], event_type: p[5], delivery_mode: p[6], channel: p[7],
                    recipient: p[8], recipient_consent: p[9], provenance: JSON.parse(p[10]), payload: JSON.parse(p[11]),
                    shopify_send_state: p[12], dedup_key: p[13], status: p[14], provider_id: "", attempts: 0,
                    sent_at: null, claim_token: null, lease_expires_at: null };
                state.jobs.push(row);
                undo.push(() => { state.jobs = state.jobs.filter((job) => job !== row); });
                return { rows: [{ id: row.id, dedup_key: row.dedup_key, status: row.status }] };
            }
            if (query.includes("SET shopify_send_state = $4")) {
                const rows = state.jobs.filter((row) => String(row.integration_id) === String(p[0]) && row.account_name === p[1]
                    && row.dedup_key === p[2] && ["PENDING", "DEFERRED"].includes(row.status) && row.shopify_send_state === "UNKNOWN");
                rows.forEach((row) => update(row, { shopify_send_state: p[3], status: "PENDING" }));
                return { rows: rows.map((row) => ({ id: row.id, status: row.status })) };
            }
            if (query.includes("SET status = 'PENDING', updated_at = now()")) {
                state.jobs.filter((row) => String(row.integration_id) === String(p[0]) && row.account_name === p[1]
                    && row.status === "DEFERRED" && (p.length < 3 || row.event_type === p[2]))
                    .forEach((row) => update(row, { status: "PENDING" }));
                return { rows: [] };
            }
            if (query.includes("outcome_code = 'STALE_CLAIM'")) {
                state.jobs.filter((row) => row.status === "SENDING" && row.lease_expires_at < Date.now() && !state.locks.has(row.id))
                    .forEach((row) => update(row, { status: "UNCERTAIN", outcome_code: "STALE_CLAIM", claim_token: null }));
                return { rows: [] };
            }
            if (query.startsWith("SELECT o.*")) {
                const row = state.jobs.find((job) => !state.locks.has(job.id) && (job.status === "PENDING"
                    || (job.status === "UNCERTAIN" && p[0] && job.provider_id === p[1] && job.attempts < p[2])));
                if (!row) return { rows: [] };
                state.locks.set(row.id, owner);
                return { rows: [structuredClone(row)] };
            }
            if (query.includes("attempts = attempts + 1")) {
                const row = state.jobs.find((job) => job.id === p[0]);
                update(row, { status: "SENDING", provider_id: p[1], claim_token: p[2], attempts: row.attempts + 1,
                    lease_expires_at: Date.now() + p[3] });
                return { rows: [] };
            }
            if (query.startsWith("SELECT id FROM shopify_delivery_notification_outbox")) {
                const row = state.jobs.find((job) => job.id === p[0] && job.claim_token === p[1] && job.status === "SENDING");
                if (row) state.locks.set(row.id, owner);
                return { rows: row ? [{ id: row.id }] : [] };
            }
            if (query.includes("SET status = $3")) {
                const row = state.jobs.find((job) => job.id === p[0] && job.claim_token === p[1] && job.status === "SENDING");
                if (!row) return { rows: [] };
                update(row, { status: p[2], outcome_code: p[3], provider_message_id: p[4],
                    sent_at: p[2] === "SENT" ? new Date().toISOString() : null, claim_token: null, lease_expires_at: null });
                return { rows: [{ id: row.id, status: row.status }] };
            }
            throw new Error(`Unhandled test query: ${query}`);
        } };
    } };
    return db;
}

function input(db) {
    return { db, integrationId: "1", accountName: "TEST-ACCOUNT",
        shipment: { companyId: "TEST-ACCOUNT", storeId: "1", warehouseId: "TEST-WAREHOUSE",
            orderId: "TEST-ORDER", id: "TEST-SHIPMENT", orderNumber: "TEST-1001", carrier: "Test Carrier",
            trackingNumber: "TEST-PARCEL", trackingUrl: "https://example.invalid/track" },
        event: { status: "DELIVERED", eventAt: "2026-09-17T12:00:00Z", description: "Test delivered scan" },
        recipient: { email: "test@example.invalid", phone: "+15555550100", smsConsent: true },
        provenance: { sourceType: "TEST-FIXTURE", sourceRef: "TEST-SCAN", accessToken: "DO-NOT-RETAIN" } };
}

function provider(send = async () => ({ state: "SENT", messageId: "TEST-RECEIPT" })) {
    const calls = [];
    return { id: "test-provider", emailConfigured: true, smsConfigured: true, calls, async sendEMAIL(message) { calls.push(message); return send(message); },
        async sendSMS(message) { calls.push(message); return send(message); } };
}

test("settings API has OFF defaults, strict booleans, explicit UI modes and safe URLs", () => {
    const defaults = sanitizeSettings();
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.smsEnabled, false);
    assert.equal(defaults.mode, "SHOPIFY");
    assert.equal(sanitizeSettings({ enabled: "true", smsEnabled: 1 }).enabled, false);
    assert.equal(sanitizeSettings({ enabled: "true", smsEnabled: 1 }).smsEnabled, false);
    assert.equal(sanitizeSettings({ logoUrl: "javascript:alert(1)" }).logoUrl, "");
    for (const mode of ["SHOPIFY", "WMS365", "BOTH"]) assert.equal(sanitizeSettings({ mode }).mode, mode);
    for (const settings of [null, [], { mode: "WMS" }, { events: ["BILLING"] }, { events: null }]) {
        assert.throws(() => sanitizeSettings(settings), TypeError);
    }
    assert.deepEqual(sanitizeSettings({ events: [] }).events, []);
});

test("settings read/save is tenant-scoped and missing configuration never sends", async () => {
    const db = database(null);
    assert.equal((await getDeliveryNotificationSettings(input(db))).enabled, false);
    assert.equal((await enqueueDeliveryNotifications(input(db))).reason, "SETTINGS_OFF");
    const p = provider();
    assert.deepEqual(await runDeliveryNotificationWorker({ db, provider: p }), []);
    assert.equal(p.calls.length, 0);
    const saved = await setDeliveryNotificationSettings({ ...input(db), settings: { enabled: true, mode: "WMS365" } });
    assert.equal(saved.enabled, true);
    assert.deepEqual(await getDeliveryNotificationSettings(input(db)), saved);
    await assert.rejects(getDeliveryNotificationSettings({ ...input(db), accountName: "OTHER-ACCOUNT" }), /not found/);
    db.state.integrations[0].provider = "SFTP";
    await assert.rejects(setDeliveryNotificationSettings({ ...input(db), settings: { enabled: true } }), /not found/);
});

test("enqueue is durable, deduplicated, allowlisted and never calls a sender", async () => {
    const db = database();
    const first = await enqueueDeliveryNotifications(input(db));
    assert.equal(first.queued.length, 1);
    assert.equal((await enqueueDeliveryNotifications(input(db))).queued.length, 0);
    const row = db.state.jobs[0];
    assert.equal(row.status, "PENDING");
    assert.equal(row.delivery_mode, "WMS365");
    assert.equal(row.recipient, "test@example.invalid");
    assert.equal(row.sent_at, null);
    assert.match(row.dedup_key, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(row).includes("DO-NOT-RETAIN"), false);
    assert.deepEqual(row.provenance, { sourceType: "TEST-FIXTURE", sourceRef: "TEST-SCAN", shopifyEvidenceRef: "", notificationSource: "WMS" });
    const otherRecipient = { ...input(db), recipient: { email: "other@example.invalid" } };
    assert.equal((await enqueueDeliveryNotifications(otherRecipient)).queued.length, 1);
    const crossTenant = input(db);
    crossTenant.shipment.companyId = "OTHER-ACCOUNT";
    await assert.rejects(enqueueDeliveryNotifications(crossTenant), /does not belong/);
});

test("UNKNOWN Shopify state persists DEFERRED, never success; confirmation enables fallback", async () => {
    const db = database({ enabled: true, mode: "SHOPIFY" });
    const result = await enqueueDeliveryNotifications(input(db));
    assert.equal(result.decision, "DEFER");
    assert.equal(db.state.jobs[0].status, "DEFERRED");
    assert.equal(db.state.jobs[0].sent_at, null);
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 0);
    await recordShopifySendState({ ...input(db), dedupKey: db.state.jobs[0].dedup_key, state: "NOT_SENT" });
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 1);
    assert.equal(db.state.jobs[0].status, "SENT");
    assert.ok(db.state.jobs[0].sent_at);
    await assert.rejects(recordShopifySendState({ ...input(db), dedupKey: db.state.jobs[0].dedup_key, state: "UNKNOWN" }), /Confirmed/);
});

test("a confirmed Shopify send suppresses WMS fallback rather than logging WMS success", async () => {
    const db = database({ enabled: true, mode: "SHOPIFY" });
    await enqueueDeliveryNotifications(input(db));
    await recordShopifySendState({ ...input(db), dedupKey: db.state.jobs[0].dedup_key, state: "SENT" });
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 0);
    assert.equal(db.state.jobs[0].status, "SUPPRESSED");
    assert.equal(db.state.jobs[0].sent_at, null);
});

test("worker sends confirmed receipts once, with stable idempotency keys and safe template rendering", async () => {
    const db = database({ enabled: true, mode: "BOTH", brandName: "Test Brand",
        messageTemplate: '<script>{{orderNumber}}</script> {{trackingUrl}}' });
    await enqueueDeliveryNotifications(input(db));
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].idempotencyKey, db.state.jobs[0].dedup_key);
    assert.equal(p.calls[0].deliveryMode, "BOTH");
    assert.equal(p.calls[0].scope.companyId, "TEST-ACCOUNT");
    assert.doesNotMatch(p.calls[0].html, /<script>/);
    assert.match(p.calls[0].html, /&lt;script&gt;TEST-1001/);
    assert.equal(db.state.jobs[0].provider_message_id, "TEST-RECEIPT");
});

test("exceptions, missing receipts and timeouts remain UNCERTAIN and never replay by default", async () => {
    for (const send of [async () => { throw new Error("secret provider failure"); }, async () => undefined,
        async () => ({ state: "SENT" }), () => new Promise(() => {})]) {
        const db = database();
        await enqueueDeliveryNotifications(input(db));
        const p = provider(send);
        await runDeliveryNotificationWorker({ db, provider: p, timeoutMs: 5 });
        await runDeliveryNotificationWorker({ db, provider: p, timeoutMs: 5 });
        assert.equal(p.calls.length, 1);
        assert.equal(db.state.jobs[0].status, "UNCERTAIN");
        assert.equal(db.state.jobs[0].sent_at, null);
        assert.equal(JSON.stringify(db.state.jobs[0]).includes("secret provider failure"), false);
    }
});

test("ambiguous sends replay only for the same provider's explicit idempotency contract, bounded", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    const first = provider(async () => undefined);
    await runDeliveryNotificationWorker({ db, provider: first, limit: 1 });
    const changedProvider = provider();
    changedProvider.id = "different-provider";
    changedProvider.supportsIdempotency = true;
    await runDeliveryNotificationWorker({ db, provider: changedProvider });
    assert.equal(changedProvider.calls.length, 0);
    const retry = provider();
    retry.supportsIdempotency = true;
    await runDeliveryNotificationWorker({ db, provider: retry });
    assert.equal(retry.calls.length, 1);
    assert.equal(first.calls[0].idempotencyKey, retry.calls[0].idempotencyKey);
    assert.equal(db.state.jobs[0].status, "SENT");
    const boundedDb = database();
    await enqueueDeliveryNotifications(input(boundedDb));
    const uncertain = provider(async () => undefined);
    uncertain.supportsIdempotency = true;
    await runDeliveryNotificationWorker({ db: boundedDb, provider: uncertain, maxAttempts: 2 });
    assert.equal(uncertain.calls.length, 2);
    assert.equal(boundedDb.state.jobs[0].status, "UNCERTAIN");
});

test("stale committed claims become UNCERTAIN and cannot be replayed without idempotency", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    Object.assign(db.state.jobs[0], { status: "SENDING", provider_id: "test-provider", attempts: 1,
        claim_token: "old-token", lease_expires_at: Date.now() - 1000 });
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(db.state.jobs[0].status, "UNCERTAIN");
    assert.equal(p.calls.length, 0);
});

test("concurrent workers skip claimed rows rather than deliver them twice", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    let complete;
    const p = provider(() => new Promise((resolve) => { complete = resolve; }));
    const first = runDeliveryNotificationWorker({ db, provider: p, limit: 1 });
    while (!complete) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await runDeliveryNotificationWorker({ db, provider: p, limit: 1 }), []);
    complete({ state: "SENT", messageId: "TEST-CONCURRENT" });
    await first;
    assert.equal(p.calls.length, 1);
});

test("settings opt-out, changed events/mode and inactive integrations stop queued delivery", async () => {
    for (const settings of [{ enabled: false }, { enabled: true, mode: "WMS365", events: [] },
        { enabled: true, mode: "SHOPIFY" }]) {
        const db = database();
        await enqueueDeliveryNotifications(input(db));
        await setDeliveryNotificationSettings({ ...input(db), settings });
        const p = provider();
        await runDeliveryNotificationWorker({ db, provider: p });
        assert.equal(p.calls.length, 0);
        assert.ok(["SUPPRESSED", "DEFERRED"].includes(db.state.jobs[0].status));
    }
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    db.state.integrations[0].is_active = false;
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 0);
    assert.equal(db.state.jobs[0].outcome_code, "INTEGRATION_UNAVAILABLE");
});

test("SMS rechecks current consent/contact and cannot send from stale consent snapshots", async () => {
    for (const current of [undefined, { phone: "+15555550100", smsConsent: false },
        { phone: "+15555550200", smsConsent: true }, { phone: "+15555550100", smsConsent: true }]) {
        const db = database({ enabled: true, mode: "WMS365", smsEnabled: true });
        const data = input(db);
        delete data.recipient.email;
        await enqueueDeliveryNotifications(data);
        const p = provider();
        await runDeliveryNotificationWorker({ db, provider: p,
            ...(current ? { resolveRecipient: async () => current } : {}) });
        assert.equal(p.calls.length, current?.smsConsent && current.phone === "+15555550100" ? 1 : 0);
    }
});

test("explicit NOT_SENT and absent channel implementations fail without blind retries", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    const p = provider(async () => ({ state: "NOT_SENT" }));
    await runDeliveryNotificationWorker({ db, provider: p });
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 1);
    assert.equal(db.state.jobs[0].status, "FAILED");
    assert.equal(db.state.jobs[0].sent_at, null);
    const missing = database();
    await enqueueDeliveryNotifications(input(missing));
    await runDeliveryNotificationWorker({ db: missing, provider: { id: "test-provider" } });
    assert.equal(missing.state.jobs[0].outcome_code, "PROVIDER_CHANNEL_UNAVAILABLE");
});

test("SQL contracts use parameterized scope, durable claims, unique dedup and SKIP LOCKED", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    await runDeliveryNotificationWorker({ db, provider: provider() });
    const queries = db.state.queries.map((entry) => entry.sql).join("\n");
    assert.match(queries, /FOR UPDATE OF o SKIP LOCKED LIMIT 1/);
    assert.match(queries, /WHERE id = \$1 AND account_name = \$2 FOR SHARE/);
    assert.match(queries, /WHERE id = \$1 AND claim_token = \$2 AND status = 'SENDING'/);
    assert.match(queries, /ON CONFLICT \(integration_id, account_name, dedup_key\) DO NOTHING/);
    const migration = fs.readFileSync(path.join(__dirname, "migrations", "20260917_shopify_delivery_notifications.sql"), "utf8");
    assert.match(migration, /enabled boolean not null default false/);
    assert.match(migration, /sms_enabled boolean not null default false/);
    assert.match(migration, /unique \(integration_id, account_name, dedup_key\)/);
    assert.match(migration, /check \(\(status = 'SENT'\) = \(sent_at is not null\)\)/);
    assert.doesNotMatch(migration, /alter table|drop table|update store_integrations/i);
});

test("transactions roll back cross-scope input and worker option validation fails before send", async () => {
    const db = database();
    const invalid = input(db);
    invalid.shipment.storeId = "999";
    await assert.rejects(enqueueDeliveryNotifications(invalid), /does not belong/);
    assert.equal(db.state.jobs.length, 0);
    assert.ok(db.state.queries.some((entry) => entry.sql === "ROLLBACK"));
    const p = provider();
    for (const options of [{ limit: 0 }, { timeoutMs: -1 }, { maxAttempts: 100 }, { provider: { id: "" } }]) {
        await assert.rejects(runDeliveryNotificationWorker({ db, provider: p, ...options }), TypeError);
    }
    assert.equal(p.calls.length, 0);
});

test("native review API is audited, bound to the integration and requeues only deferred matching events", async () => {
    const db = database();
    db.state.reviews = [];
    const defaults = await getDeliveryNotificationSettings(input(db));
    assert.equal(defaults.shopifyNativeEvents.DELIVERED.state, "UNKNOWN");
    const futureEvent = input(db);
    futureEvent.event.eventAt = new Date(Date.now() + 60000).toISOString();
    await enqueueDeliveryNotifications(futureEvent);
    assert.equal(db.state.jobs[0].status, "DEFERRED");
    await setDeliveryNotificationSettings({ ...input(db), settings: { enabled: true, mode: "WMS365",
        shopifyNativeEvents: { DELIVERED: { state: "DISABLED", companyId: "TEST-ACCOUNT", storeId: "1",
            reviewedBy: "FORGED-UI", reviewedAt: "2026-09-17T10:00:00Z", evidenceRef: "FORGED-UI" } } } });
    assert.equal((await getDeliveryNotificationSettings(input(db))).shopifyNativeEvents.DELIVERED.state, "UNKNOWN");
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 0);
    const reviewed = await recordShopifyNotificationConfiguration({ ...input(db), event: "DELIVERED",
        state: "DISABLED", reviewedBy: "AUTHENTICATED-TEST-ADMIN", evidenceRef: "TEST-SHOPIFY-CONFIG" });
    assert.equal(db.state.audit.length, 1);
    assert.equal(reviewed.shopifyNativeEvents.DELIVERED.storeId, "1");
    assert.equal(reviewed.shopifyNativeEvents.DELIVERED.companyId, "TEST-ACCOUNT");
    assert.equal(reviewed.shopifyNativeEvents.DELIVERED.reviewedBy, "AUTHENTICATED-TEST-ADMIN");
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 1);
    await assert.rejects(recordShopifyNotificationConfiguration({ ...input(db), accountName: "OTHER-ACCOUNT",
        event: "DELIVERED", state: "DISABLED", reviewedBy: "TEST", evidenceRef: "TEST" }), /not found/);
    assert.equal(db.state.audit.length, 1);
});

test("SHIPPED REQUESTED is durably suppressed without claiming an email receipt", async () => {
    for (const mode of ["SHOPIFY", "WMS365", "BOTH"]) {
        const db = database({ enabled: true, mode });
        const data = input(db);
        data.event.status = "SHIPPED";
        data.shopifySendState = "REQUESTED";
        await enqueueDeliveryNotifications(data);
        assert.equal(db.state.jobs[0].shopify_send_state, "REQUESTED");
        assert.equal(db.state.jobs[0].sent_at, null);
        assert.equal(db.state.jobs[0].provenance.notificationSource, "SHOPIFY_REQUESTED");
        const p = provider();
        await runDeliveryNotificationWorker({ db, provider: p });
        assert.equal(p.calls.length, mode === "BOTH" ? 1 : 0);
    }
});

test("switching to WMS mode and disabling native emails does not send an older deferred event", async () => {
    const db = database({ enabled: true, mode: "SHOPIFY" });
    db.state.reviews.find((review) => review.event_type === "DELIVERED").configuration_state = "ENABLED";
    const oldEvent = input(db);
    oldEvent.event.eventAt = "2000-01-01T12:00:00Z";
    await enqueueDeliveryNotifications(oldEvent);
    assert.equal(db.state.jobs[0].status, "DEFERRED");
    await setDeliveryNotificationSettings({ ...input(db), settings: { enabled: true, mode: "WMS365" } });
    const settings = await recordShopifyNotificationConfiguration({ ...input(db), event: "DELIVERED",
        state: "DISABLED", reviewedBy: "AUTHENTICATED-TEST-ADMIN", evidenceRef: "TEST-LATER-DISABLE" });
    assert.ok(Date.parse(settings.shopifyNativeEvents.DELIVERED.reviewedAt) > Date.parse(oldEvent.event.eventAt));
    assert.equal(db.state.jobs[0].status, "PENDING");
    const p = provider();
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 0);
    assert.equal(db.state.jobs[0].status, "DEFERRED");
    assert.equal(db.state.jobs[0].sent_at, null);
    assert.equal(db.state.jobs[0].shopify_send_state, "UNKNOWN");
    await recordShopifySendState({ ...input(db), dedupKey: db.state.jobs[0].dedup_key, state: "NOT_SENT" });
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(p.calls.length, 1);
    assert.equal(db.state.jobs[0].status, "SENT");
});

test("provider capabilities require explicit configured flags, never mere SMS stubs", async () => {
    assert.deepEqual(getDeliveryNotificationCapabilities(), { emailConfigured: false, smsConfigured: false });
    assert.deepEqual(getDeliveryNotificationCapabilities({ id: "test", sendEMAIL() {}, sendSMS() {} }),
        { emailConfigured: false, smsConfigured: false });
    const p = provider();
    p.smsConfigured = false;
    assert.deepEqual(getDeliveryNotificationCapabilities(p), { emailConfigured: true, smsConfigured: false });
    const db = database({ enabled: true, mode: "WMS365", smsEnabled: true });
    const data = input(db);
    delete data.recipient.email;
    await enqueueDeliveryNotifications(data);
    await runDeliveryNotificationWorker({ db, provider: p, resolveRecipient: async () => data.recipient });
    assert.equal(p.calls.length, 0);
    assert.equal(db.state.jobs[0].outcome_code, "PROVIDER_CHANNEL_UNAVAILABLE");
});

test("a successful send followed by a log-write failure stays a committed claim, not replayable pending", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    const originalConnect = db.connect;
    db.connect = async () => {
        const client = await originalConnect();
        const query = client.query;
        client.query = async (sql, parameters) => {
            if (sql.includes("SET status = $3")) throw new Error("TEST-FINALIZE-FAILURE");
            return query(sql, parameters);
        };
        return client;
    };
    const p = provider();
    await assert.rejects(runDeliveryNotificationWorker({ db, provider: p }), /TEST-FINALIZE-FAILURE/);
    assert.equal(p.calls.length, 1);
    assert.equal(db.state.jobs[0].status, "SENDING");
    db.connect = originalConnect;
    db.state.jobs[0].lease_expires_at = Date.now() - 1;
    await runDeliveryNotificationWorker({ db, provider: p });
    assert.equal(db.state.jobs[0].status, "UNCERTAIN");
    assert.equal(p.calls.length, 1);
});

test("additive migration applies in isolated memory with OFF defaults and enforced delivery constraints", () => {
    const { newDb, DataType } = require("pg-mem");
    // Repeated IF NOT EXISTS statements intentionally skip planning their columns.
    const memory = newDb({ noAstCoverageCheck: true });
    memory.public.registerFunction({ name: "length", args: [DataType.text], returns: DataType.integer,
        implementation: (value) => value.length });
    memory.public.registerFunction({ name: "jsonb_typeof", args: [DataType.jsonb], returns: DataType.text,
        implementation: (value) => Array.isArray(value) ? "array" : typeof value });
    memory.public.registerOperator({ operator: "<@", left: DataType.jsonb, right: DataType.jsonb,
        returns: DataType.bool, implementation: (left, right) => Array.isArray(left) && left.every((value) => right.includes(value)) });
    memory.public.none("CREATE TABLE store_integrations (id bigserial primary key, account_name text not null)");
    const migration = fs.readFileSync(path.join(__dirname, "migrations", "20260917_shopify_delivery_notifications.sql"), "utf8");
    memory.public.none(migration);
    memory.public.none(migration);
    memory.public.none("INSERT INTO store_integrations (account_name) VALUES ('TEST-ACCOUNT')");
    memory.public.none("INSERT INTO shopify_delivery_notification_settings (integration_id) VALUES (1)");
    const settings = memory.public.one("SELECT * FROM shopify_delivery_notification_settings WHERE integration_id = 1");
    assert.equal(settings.enabled, false);
    assert.equal(settings.sms_enabled, false);
    assert.equal(settings.delivery_mode, "SHOPIFY");
    memory.public.none(`UPDATE shopify_delivery_notification_settings SET enabled_events = '["PICKED_UP"]'::jsonb`);
    assert.throws(() => memory.public.none(`UPDATE shopify_delivery_notification_settings SET enabled_events = '["BILLING"]'::jsonb`));
    const insert = `INSERT INTO shopify_delivery_notification_outbox
        (integration_id,account_name,warehouse_id,order_id,shipment_id,event_type,delivery_mode,channel,recipient,payload,dedup_key,status)
        VALUES (1,'TEST-ACCOUNT','TEST-WAREHOUSE','TEST-ORDER','TEST-SHIPMENT','DELIVERED','WMS365','EMAIL',
        'test@example.invalid','{}'::jsonb,'TEST-KEY','PENDING')`;
    memory.public.none(insert);
    assert.throws(() => memory.public.none(insert));
    assert.throws(() => memory.public.none("UPDATE shopify_delivery_notification_outbox SET status = 'SENT'"));
    assert.throws(() => memory.public.none("UPDATE shopify_delivery_notification_outbox SET channel = 'SMS'"));
});

test("pending delivered notifications suppress unverified evidence without calling a provider", async () => {
    for (const [validation, expectedCode] of [
        [async () => false, "DELIVERY_EVIDENCE_UNVERIFIED"],
        [async () => undefined, "DELIVERY_EVIDENCE_UNVERIFIED"],
        [async () => { throw new Error("TEST-PRIVATE-EVIDENCE-FAILURE"); }, "EVENT_UNVERIFIED"]
    ]) {
        const db = database();
        await enqueueDeliveryNotifications(input(db));
        assert.equal(db.state.jobs[0].status, "PENDING");
        assert.equal(db.state.jobs[0].event_type, "DELIVERED");
        const p = provider();
        const result = await runDeliveryNotificationWorker({ db, provider: p, validateEvent: validation });
        assert.equal(p.calls.length, 0);
        assert.equal(result[0].status, "SUPPRESSED");
        assert.equal(db.state.jobs[0].status, "SUPPRESSED");
        assert.equal(db.state.jobs[0].sent_at, null);
        assert.equal(db.state.jobs[0].outcome_code, expectedCode);
        assert.equal(JSON.stringify(db.state.jobs[0]).includes("TEST-PRIVATE-EVIDENCE-FAILURE"), false);
    }
});

test("validateEvent receives the dedicated send-transaction client and row while locks remain held", async () => {
    const db = database();
    await enqueueDeliveryNotifications(input(db));
    const clients = [];
    const originalConnect = db.connect;
    db.connect = async () => {
        const client = await originalConnect();
        const queries = [];
        const query = client.query;
        client.query = async (sql, parameters) => { queries.push(sql); return query(sql, parameters); };
        clients.push({ client, queries });
        return client;
    };
    let validationClient;
    let validated = false;
    const p = provider(async () => {
        assert.equal(validated, true);
        assert.equal(db.state.locks.has(db.state.jobs[0].id), true);
        const current = clients[clients.length - 1];
        assert.equal(current.client, validationClient);
        assert.equal(current.queries.includes("COMMIT"), false);
        return { state: "SENT", messageId: "TEST-VALIDATED-RECEIPT" };
    });
    await runDeliveryNotificationWorker({ db, provider: p, validateEvent: async ({ client, row }) => {
        validationClient = client;
        const current = clients[clients.length - 1];
        assert.equal(client, current.client);
        assert.notEqual(client, db);
        assert.equal(row.id, db.state.jobs[0].id);
        assert.equal(row.account_name, "TEST-ACCOUNT");
        assert.equal(row.integration_id, "1");
        assert.equal(row.event_type, "DELIVERED");
        assert.equal(row.payload.event.status, "DELIVERED");
        assert.equal(current.queries[0], "BEGIN");
        assert.ok(current.queries.some((sql) => /claim_token.*FOR UPDATE/s.test(sql)));
        assert.ok(current.queries.some((sql) => /notification_settings.*FOR SHARE/s.test(sql)));
        assert.equal(current.queries.includes("COMMIT"), false);
        const scoped = await client.query(`SELECT id, account_name, provider, is_active
            FROM store_integrations WHERE id = $1 AND account_name = $2 FOR SHARE`, [row.integration_id, row.account_name]);
        assert.equal(scoped.rows[0].account_name, row.account_name);
        validated = true;
        return true;
    } });
    assert.equal(p.calls.length, 1);
    assert.equal(db.state.jobs[0].status, "SENT");
    assert.equal(clients[clients.length - 1].queries.at(-1), "COMMIT");
    assert.equal(db.state.locks.size, 0);
});
