const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
    afterShipCarrierSlug,
    calculateNextTrackingPoll,
    isTerminalTrackingStatus,
    normalizeAfterShipTracking,
    normalizeTrackingCarrier,
    normalizeTrackingStatus,
    sanitizeTrackingEvent,
    verifyWebhookHmac
} = require("./carrier-tracking");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const portal = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");

test("normalizes common carrier status vocabulary into the WMS365 timeline", () => {
    assert.equal(normalizeTrackingStatus("InfoReceived"), "LABEL_CREATED");
    assert.equal(normalizeTrackingStatus("InTransit"), "IN_TRANSIT");
    assert.equal(normalizeTrackingStatus("OutForDelivery"), "OUT_FOR_DELIVERY");
    assert.equal(normalizeTrackingStatus("AttemptFail"), "DELIVERY_ATTEMPTED");
    assert.equal(normalizeTrackingStatus("Delivered"), "DELIVERED");
    assert.equal(isTerminalTrackingStatus("Delivered"), true);
});

test("maps Canadian parcel and freight carriers to a broad tracking provider", () => {
    assert.equal(normalizeTrackingCarrier("ICS Courier"), "ICS_COURIER");
    assert.equal(afterShipCarrierSlug("ICS Courier"), "icscourier");
    assert.equal(afterShipCarrierSlug("Day & Ross"), "dayross");
    assert.equal(afterShipCarrierSlug("Canada Post"), "canada-post");
});

test("converts provider checkpoints without retaining the full provider payload", () => {
    const result = normalizeAfterShipTracking({
        msg: {
            tracking: {
                id: "provider-1",
                slug: "ups",
                tag: "InTransit",
                expected_delivery: "2026-09-16T17:00:00Z",
                checkpoints: [{
                    id: "event-1",
                    tag: "InTransit",
                    subtag: "InTransit_001",
                    message: "Shipment departed carrier facility",
                    city: "Toronto",
                    state: "Ontario",
                    country_region_name: "Canada",
                    checkpoint_time: "2026-09-13T12:30:00Z",
                    confidential_customer_data: "must not survive"
                }]
            }
        }
    });
    assert.equal(result.status, "IN_TRANSIT");
    assert.equal(result.events[0].location, "Toronto, Ontario, Canada");
    assert.equal(Object.prototype.hasOwnProperty.call(result.events[0], "confidential_customer_data"), false);
});

test("tracking event fingerprints are stable and webhook HMAC checks are timing safe", () => {
    const first = sanitizeTrackingEvent({ status: "InTransit", description: "Departed", eventAt: "2026-09-13T12:30:00Z" });
    const second = sanitizeTrackingEvent({ status: "IN_TRANSIT", description: "Departed", event_at: "2026-09-13T12:30:00Z" });
    assert.equal(first.eventKey, second.eventKey);
    const body = Buffer.from('{"event":"tracking_update"}');
    const secret = "test-secret";
    const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
    assert.equal(verifyWebhookHmac(body, signature, secret), true);
    assert.equal(verifyWebhookHmac(body, "invalid", secret), false);
});

test("tracking polling backs off and stops for terminal statuses", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    assert.equal(calculateNextTrackingPoll({ status: "DELIVERED", attempts: 1, now }), null);
    assert.equal(calculateNextTrackingPoll({ status: "IN_TRANSIT", attempts: 1, now }), "2026-09-13T12:15:00.000Z");
    assert.equal(calculateNextTrackingPoll({ status: "IN_TRANSIT", attempts: 4, now }), "2026-09-13T14:00:00.000Z");
});

test("tracking storage is shipment-owned, append-only, deduplicated, and safely claimed", () => {
    assert.match(server, /create table if not exists shipment_trackers/);
    assert.match(server, /account_name text not null/);
    assert.match(server, /fulfillment_location_id bigint not null/);
    assert.match(server, /unique \(warehouse_shipment_id, tracking_number\)/);
    assert.match(server, /shipment_tracking_events_append_only/);
    assert.match(server, /unique \(tracker_id, event_key\)/);
    assert.match(server, /for update skip locked/i);
});

test("customer, warehouse, and partner reads remain ownership scoped", () => {
    const helper = server.slice(server.indexOf("async function getShipmentTrackingForOrder"), server.indexOf("async function appendShipmentTrackingEvent"));
    assert.match(helper, /t\.order_id = \$1 and t\.account_name = \$2/);
    assert.match(helper, /t\.fulfillment_location_id/);
    assert.match(server, /assertAppUserCustomerWarehouseAccess[\s\S]*PORTAL_ORDER_TRACKING/);
    assert.match(server, /getWarehouseShipmentDetail\(pool, req\.params\.id, req\.partnerApi\.accountName\)/);
    assert.match(server, /select id from portal_orders where id=\$1 and account_name=\$2/);
});

test("shipment completion creates trackers and the customer portal renders a selected-warehouse timeline", () => {
    assert.match(server, /status === "SHIPPED"[\s\S]*syncShipmentTrackersForWarehouseShipment/);
    assert.match(server, /ensureCarrierTrackingWorkerStarted\(\)/);
    assert.match(portal, /Delivery Tracking/);
    assert.match(portal, /portalWarehouseScopedUrl\(`\/api\/portal\/orders\/\$\{encodeURIComponent\(orderId\)\}\/tracking`\)/);
    assert.match(portal, /Open Carrier Tracking/);
});

test("provider secrets stay server-side and carrier polling is credential gated", () => {
    assert.match(server, /AFTERSHIP_TRACKING_API_KEY = readEnv/);
    assert.match(server, /if \(!databaseReady \|\| !AFTERSHIP_TRACKING_API_KEY\) return \{ processed: 0 \}/);
    assert.match(server, /https:\/\/api\.aftership\.com\/tracking\/2026-07/);
    assert.match(server, /"as-api-key": AFTERSHIP_TRACKING_API_KEY/);
    assert.match(server, /tracking_numbers=\$\{encodeURIComponent\(tracker\.tracking_number\)\}/);
    assert.doesNotMatch(server, /trackings\/\$\{encodeURIComponent\(tracker\.carrier_slug\)\}\/\$\{encodeURIComponent\(tracker\.tracking_number\)\}/);
    assert.doesNotMatch(portal, /AFTERSHIP_TRACKING_API_KEY|aftership-api-key/);
});
