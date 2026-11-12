"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    DEFAULT_ENABLED_EVENTS, normalizePolicy, buildNotificationKey,
    evaluateDeliveryNotification, renderNotification, escapeHtml, safeUrl
} = require("./shopify-delivery-notifications");

function fixture(mode = "WMS", status = "SHIPPED") {
    const shopifyNativeEvents = Object.fromEntries(["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].map((event) => [event, {
        state: "DISABLED", companyId: "company-test", storeId: "store-test",
        reviewedAt: "2026-09-17T10:00:00Z", reviewedBy: "TEST-REVIEWER", evidenceRef: "TEST-CONFIG-REVIEW"
    }]));
    return {
        store: { id: "store-test", companyId: "company-test", notificationMode: mode, shopifyNativeEvents,
            branding: { name: "Test Store", logoUrl: "https://example.invalid/logo.png",
                websiteUrl: "https://example.invalid/" } },
        shipment: { id: "shipment-test", companyId: "company-test", storeId: "store-test",
            warehouseId: "warehouse-test", orderId: "order-test", orderNumber: "TEST-1001",
            carrier: "Test Carrier", trackingNumber: "TEST-TRACKING",
            trackingUrl: "https://example.invalid/track?a=1&b=2" },
        event: { status, eventAt: "2026-09-17T12:00:00Z", description: "Carrier scan",
            location: "Test City", estimatedDelivery: "2026-09-18T17:00:00Z" },
        recipient: { email: "recipient@example.invalid", phone: "+15555550100", smsConsent: true }
    };
}

test("defaults are store-local, conservative, immutable and explicitly configurable", () => {
    assert.deepEqual(normalizePolicy(), { mode: "SHOPIFY", enabledEvents: DEFAULT_ENABLED_EVENTS, smsEnabled: false });
    assert.deepEqual(DEFAULT_ENABLED_EVENTS, ["SHIPPED", "EXCEPTION", "OUT_FOR_DELIVERY", "DELIVERY_ATTEMPTED", "DELIVERED"]);
    assert.equal(Object.isFrozen(DEFAULT_ENABLED_EVENTS), true);
    const policy = normalizePolicy();
    policy.enabledEvents.push("IN_TRANSIT");
    assert.equal(normalizePolicy().enabledEvents.includes("IN_TRANSIT"), false);
    assert.deepEqual(normalizePolicy({ enabledEvents: [] }).enabledEvents, []);
    assert.deepEqual(normalizePolicy({ enabledEvents: ["outForDelivery", "OUT_FOR_DELIVERY"] }).enabledEvents, ["OUT_FOR_DELIVERY"]);
    for (const store of [{ notificationMode: "TYPO" }, { notificationMode: null },
        { enabledEvents: null }, { enabledEvents: ["BILLING"] }]) {
        assert.throws(() => normalizePolicy(store), TypeError);
    }
});

test("SHOPIFY unknown state defers; only confirmed NOT_SENT permits WMS fallback", () => {
    const input = fixture("SHOPIFY");
    for (const state of [undefined, null, false, true, "ASSUMED_NOT_SENT", "FAILED", "UNKNOWN", "not_sent"]) {
        const result = evaluateDeliveryNotification({ ...input, shopifySendState: state });
        assert.equal(result.decision, "DEFER");
        assert.equal(result.reason, "SHOPIFY_SEND_UNKNOWN");
        assert.deepEqual(result.notifications, []);
    }
    assert.equal(evaluateDeliveryNotification({ ...input, shopifySendState: "SENT" }).reason, "SHOPIFY_SENT");
    const fallback = evaluateDeliveryNotification({ ...input, shopifySendState: "NOT_SENT" });
    assert.equal(fallback.decision, "SEND");
    assert.equal(fallback.reason, "CONFIRMED_SHOPIFY_NOT_SENT");
    assert.equal(fallback.notifications[0].provider, "WMS");
});

test("WMS and BOTH honor confirmed send state while preserving initial Shopify request intent", () => {
    for (const mode of ["WMS", "BOTH"]) {
        for (const state of ["UNKNOWN", "SENT", "NOT_SENT"]) {
            const result = evaluateDeliveryNotification({ ...fixture(mode), shopifySendState: state });
            const sends = mode === "BOTH" || state !== "SENT";
            assert.equal(result.decision, sends ? "SEND" : "SUPPRESS");
            assert.equal(result.shopify.enabled, true);
            assert.equal(result.shopify.initialNotifyCustomer, true);
            assert.equal(result.notifications.length, sends ? 1 : 0);
        }
    }
});

test("default milestone events send; transit and unrelated transaction types do not", () => {
    for (const status of DEFAULT_ENABLED_EVENTS) {
        assert.equal(evaluateDeliveryNotification(fixture("WMS", status)).decision, "SEND");
    }
    for (const status of ["IN_TRANSIT", "LABEL_CREATED", "RETURNED", "INBOUND", "BILLING", "UNKNOWN"]) {
        assert.equal(evaluateDeliveryNotification(fixture("WMS", status)).reason, "EVENT_DISABLED");
    }
    const input = fixture();
    input.store.enabledEvents = [];
    assert.deepEqual(evaluateDeliveryNotification(input).notifications, []);
});

test("transit keys ignore scan ID, timestamp and narrative churn, but detect location/ETA changes", () => {
    const input = fixture("WMS", "IN_TRANSIT");
    input.store.enabledEvents = ["IN_TRANSIT"];
    const first = evaluateDeliveryNotification(input).notifications[0];
    const repeated = { ...input, event: { ...input.event, eventAt: "2026-09-17T14:00:00Z",
        providerEventId: "another-scan", description: "Another transit scan", location: " test  city ",
        estimatedDelivery: "2026-09-18T13:00:00-04:00" }, sentKeys: [first.key] };
    assert.equal(buildNotificationKey(repeated), first.key);
    assert.equal(evaluateDeliveryNotification(repeated).reason, "DUPLICATE");
    for (const change of [{ location: "Next City" }, { estimatedDelivery: "2026-09-19T17:00:00Z" }]) {
        const changed = { ...repeated, event: { ...repeated.event, ...change } };
        assert.equal(evaluateDeliveryNotification(changed).decision, "SEND");
        assert.notEqual(buildNotificationKey(changed), first.key);
    }
});

test("milestones deduplicate rescan changes and confirmed fallback retries", () => {
    const input = { ...fixture("SHOPIFY", "DELIVERED"), shopifySendState: "NOT_SENT" };
    const first = evaluateDeliveryNotification(input).notifications[0];
    const retry = { ...input, sentKeys: new Set([first.key]),
        event: { ...input.event, eventAt: "2026-09-19T10:00:00Z", location: "Changed", description: "Rescan" } };
    assert.equal(evaluateDeliveryNotification(retry).reason, "DUPLICATE");
    assert.equal(evaluateDeliveryNotification({ ...retry, store: { ...input.store, notificationMode: "BOTH" } }).reason, "DUPLICATE");
});

test("SMS requires store opt-in, strict consent and a valid phone in every mode", () => {
    for (const mode of ["SHOPIFY", "WMS", "BOTH"]) {
        const input = { ...fixture(mode), shopifySendState: "NOT_SENT" };
        input.store.smsEnabled = true;
        assert.deepEqual(evaluateDeliveryNotification(input).notifications.map((n) => n.channel), ["EMAIL", "SMS"]);
        for (const consent of [undefined, null, false, "true", 1]) {
            assert.equal(evaluateDeliveryNotification({ ...input, recipient: { ...input.recipient, smsConsent: consent } })
                .notifications.some((n) => n.channel === "SMS"), false);
        }
        for (const phone of [undefined, "", "555", "+0123456789", "+1555\n5550100"]) {
            assert.equal(evaluateDeliveryNotification({ ...input, recipient: { ...input.recipient, phone } })
                .notifications.some((n) => n.channel === "SMS"), false);
        }
        input.store.smsEnabled = false;
        assert.equal(evaluateDeliveryNotification(input).notifications.length, 1);
    }
    const deferred = fixture("SHOPIFY");
    deferred.store.smsEnabled = true;
    assert.deepEqual(evaluateDeliveryNotification(deferred).notifications, []);
});

test("channel keys allow independent retries and later consent without repeating email", () => {
    const input = fixture();
    input.store.smsEnabled = true;
    const [email, sms] = evaluateDeliveryNotification(input).notifications;
    assert.notEqual(email.key, sms.key);
    const retry = evaluateDeliveryNotification({ ...input, sentKeys: [email.key] });
    assert.deepEqual(retry.notifications.map((n) => n.channel), ["SMS"]);
    assert.equal(evaluateDeliveryNotification({ ...input, sentKeys: [email.key, sms.key] }).reason, "DUPLICATE");
});

test("keys isolate companies, stores, warehouses, orders, shipments and parcels", () => {
    const input = fixture();
    const key = buildNotificationKey(input);
    const otherCompany = structuredClone(input);
    otherCompany.store.companyId = otherCompany.shipment.companyId = "other-company";
    const otherStore = structuredClone(input);
    otherStore.store.id = otherStore.shipment.storeId = "other-store";
    const variants = [otherCompany, otherStore];
    for (const field of ["warehouseId", "orderId", "id", "trackingNumber"]) {
        variants.push({ ...input, shipment: { ...input.shipment, [field]: `other-${field}` } });
    }
    for (const variant of variants) {
        assert.notEqual(buildNotificationKey(variant), key);
        assert.equal(evaluateDeliveryNotification({ ...variant, store: { ...variant.store, notificationMode: "BOTH" }, sentKeys: [key] }).decision, "SEND");
    }
    for (const field of ["companyId", "storeId"]) {
        assert.throws(() => evaluateDeliveryNotification({ ...input, shipment: { ...input.shipment, [field]: "wrong" } }), /does not belong/);
    }
    for (const field of ["companyId", "storeId", "warehouseId", "orderId", "id"]) {
        assert.throws(() => evaluateDeliveryNotification({ ...input, shipment: { ...input.shipment, [field]: "" } }), /required/);
    }
});

test("notifications carry order, carrier, link, time, scan, ETA and branding", () => {
    const input = fixture();
    const notification = evaluateDeliveryNotification(input).notifications[0];
    assert.equal(notification.content.orderNumber, "TEST-1001");
    assert.equal(notification.content.carrier, "Test Carrier");
    assert.equal(notification.content.trackingUrl, input.shipment.trackingUrl);
    assert.equal(notification.content.eventAt, "2026-09-17T12:00:00.000Z");
    assert.equal(notification.content.scan, "Carrier scan");
    assert.equal(notification.content.estimatedDelivery, "2026-09-18T17:00:00.000Z");
    assert.deepEqual(notification.content.branding, input.store.branding);
    for (const value of ["TEST-1001", "Test Carrier", "Carrier scan", "Test City", "Test Store", "ETA:"]) {
        assert.ok(notification.text.includes(value));
    }
    assert.ok(notification.html.includes("a=1&amp;b=2"));
});

test("HTML escapes all untrusted display fields; URL schemes and credentials fail closed", () => {
    const attack = '\"><script>alert(1)</script>&\'';
    assert.equal(escapeHtml(attack), "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;");
    const input = fixture();
    input.store.branding = { name: attack, logoUrl: "javascript:alert(1)", websiteUrl: "data:text/html,bad" };
    input.shipment.orderNumber = input.shipment.carrier = input.shipment.trackingNumber = attack;
    input.shipment.trackingUrl = "javascript:alert(1)";
    input.event.description = input.event.location = attack;
    const notification = evaluateDeliveryNotification(input).notifications[0];
    assert.doesNotMatch(notification.html, /<script|javascript:|data:text|<img|<a /i);
    assert.ok(notification.html.includes(escapeHtml(attack)));
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///test", "/relative", "//example.invalid",
        "https://user:pass@example.invalid/", "https://example.invalid/\nattack", "https:\\example.invalid/"]) {
        assert.equal(safeUrl(url), "");
    }
    assert.equal(safeUrl("https://example.invalid/"), "https://example.invalid/");
    assert.equal(safeUrl("http://example.invalid/track"), "http://example.invalid/track");
    const rendered = renderNotification({ branding: { name: attack, logoUrl: "javascript:bad" }, trackingUrl: "javascript:bad" });
    assert.doesNotMatch(rendered.html, /javascript:|<script/i);
});

test("invalid dates and missing recipients are safe; evaluation leaves all inputs unchanged", () => {
    const input = fixture("WMS", "EXCEPTION");
    input.event.eventAt = "not a date";
    input.event.estimatedDelivery = "not a date";
    input.sentKeys = [];
    const before = structuredClone(input);
    const result = evaluateDeliveryNotification(input);
    assert.equal(result.notifications[0].content.eventAt, "");
    assert.equal(result.notifications[0].content.estimatedDelivery, "");
    assert.match(result.notifications[0].text, /ETA: Not available/);
    result.notifications[0].content.branding.name = "Changed output";
    assert.deepEqual(input, before);
    for (const email of ["", "invalid", "a@example.invalid\nBcc: bad@example.invalid"]) {
        assert.equal(evaluateDeliveryNotification({ ...input, recipient: { email } }).reason, "NO_ELIGIBLE_RECIPIENT");
    }
    assert.throws(() => evaluateDeliveryNotification({ ...input, sentKeys: {} }), /sentKeys/);
});

test("native WMS events require scoped disabled verification, not assumed missing email", () => {
    for (const status of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
        const input = fixture("WMS", status);
        assert.equal(evaluateDeliveryNotification(input).decision, "SEND");
        for (const change of [undefined, { state: "DISABLED" },
            { ...input.store.shopifyNativeEvents[status], state: "ENABLED" },
            { ...input.store.shopifyNativeEvents[status], storeId: "other-store" },
            { ...input.store.shopifyNativeEvents[status], companyId: "other-company" },
            { ...input.store.shopifyNativeEvents[status], reviewedAt: "invalid" }]) {
            const modified = { ...input, store: { ...input.store, shopifyNativeEvents: { [status]: change } } };
            assert.equal(evaluateDeliveryNotification(modified).decision, "DEFER");
            assert.equal(evaluateDeliveryNotification({ ...modified, shopifySendState: "NOT_SENT" }).decision, "DEFER");
            assert.equal(evaluateDeliveryNotification({ ...modified, store: { ...modified.store, notificationMode: "BOTH" } }).decision, "SEND");
        }
    }
    const nonNative = fixture("WMS", "EXCEPTION");
    delete nonNative.store.shopifyNativeEvents;
    assert.equal(evaluateDeliveryNotification(nonNative).decision, "SEND");
});

test("REQUESTED preserves initial Shopify notification and blocks duplicate shipping outside BOTH", () => {
    for (const mode of ["SHOPIFY", "WMS", "BOTH"]) {
        const input = { ...fixture(mode), shopifySendState: "REQUESTED" };
        const result = evaluateDeliveryNotification(input);
        assert.equal(result.shopify.initialNotifyCustomer, true);
        assert.equal(result.shopify.sendState, "REQUESTED");
        assert.equal(result.decision, mode === "BOTH" ? "SEND" : "SUPPRESS");
        if (mode !== "BOTH") assert.equal(result.reason, "SHOPIFY_REQUESTED");
    }
});

test("PICKED_UP is optional and does not change the default event set", () => {
    const input = fixture("WMS", "PICKED_UP");
    assert.equal(evaluateDeliveryNotification(input).reason, "EVENT_DISABLED");
    input.store.enabledEvents = ["PICKED_UP"];
    assert.equal(evaluateDeliveryNotification(input).decision, "SEND");
    assert.equal(DEFAULT_ENABLED_EVENTS.includes("PICKED_UP"), false);
});

test("a later disabled review cannot release older native events with unknown Shopify send state", () => {
    for (const status of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
        const input = fixture("WMS", status);
        input.store.shopifyNativeEvents[status].reviewedAt = "2026-09-17T13:00:00Z";
        const older = evaluateDeliveryNotification(input);
        assert.equal(older.decision, "DEFER");
        assert.equal(older.reason, "SHOPIFY_NATIVE_NOT_VERIFIED_DISABLED");
        assert.deepEqual(older.notifications, []);
        assert.equal(evaluateDeliveryNotification({ ...input, shopifySendState: "NOT_SENT" }).decision, "SEND");
        assert.equal(evaluateDeliveryNotification({ ...input, store: { ...input.store, notificationMode: "BOTH" } }).decision, "SEND");
        for (const eventAt of ["2026-09-17T13:00:00Z", "2026-09-17T09:00:00-04:00", "2026-09-17T14:00:00Z"]) {
            assert.equal(evaluateDeliveryNotification({ ...input, event: { ...input.event, eventAt } }).decision, "SEND");
        }
        for (const eventAt of [undefined, "", "invalid"]) {
            const missingTime = { ...input, event: { ...input.event, eventAt } };
            assert.equal(evaluateDeliveryNotification(missingTime).decision, "DEFER");
            assert.equal(evaluateDeliveryNotification({ ...missingTime, shopifySendState: "NOT_SENT" }).decision, "SEND");
        }
    }
});
