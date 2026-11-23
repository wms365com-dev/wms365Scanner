const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAfterShipTracking, afterShipCarrierSlug } = require("./carrier-tracking");
const sync = require("./shopify-tracking-sync");
const { evaluateDeliveryNotification } = require("./shopify-delivery-notifications");

// Isolated provider, database and Shopify doubles. No network or customer writes.
for (const carrier of ["Canpar", "ICS Courier", "GLS Canada"]) {
    test(`${carrier}: confirmed scans reach Shopify and matching customer messages exactly once`, async () => {
        const remoteEvents = [];
        const sentKeys = new Set();
        const messages = [];
        const account = "CODEX PORTAL SYSTEM TEST";
        const at = "2026-09-17T12:00:00.000Z";
        const binding = { id: 1, integration_id: 1510, account_name: account,
            store_identifier: "test.myshopify.com", external_order_id: "1",
            fulfillment_gid: "gid://shopify/Fulfillment/1", enrolled_at: at,
            expires_at: "2026-11-01T12:00:00Z", expected_tracking_numbers: ["TEST-PACKAGE"] };
        const integration = { id: 1510, account_name: account, store_identifier: binding.store_identifier,
            is_active: true, settings: { carrierFulfillmentEventsEnabled: true } };
        const shipment = { id: "TEST-SHIPMENT", companyId: account, storeId: "1510", warehouseId: "TEST-WAREHOUSE",
            orderId: "TEST-ORDER", orderNumber: "TEST-SHOPIFY-ORDER", carrier,
            trackingNumber: "TEST-PACKAGE", trackingUrl: "https://tracking.example.invalid/TEST-PACKAGE" };
        const store = { id: "1510", companyId: account, notificationMode: "BOTH",
            enabledEvents: ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"], branding: { name: "Test Store" } };
        const request = async (_integration, _path, options) => {
            if (options.body.query.startsWith("query")) return { payload: { data: { fulfillment: {
                id: binding.fulfillment_gid, order: { id: "gid://shopify/Order/1" },
                events: { nodes: remoteEvents, pageInfo: { hasNextPage: false, endCursor: null } }
            } } } };
            const event = options.body.variables.event;
            const record = { id: `gid://shopify/FulfillmentEvent/${remoteEvents.length + 1}`,
                status: event.status, happenedAt: event.happenedAt };
            remoteEvents.push(record);
            return { payload: { data: { fulfillmentEventCreate: { fulfillmentEvent: record, userErrors: [] } } } };
        };
        const progression = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];
        for (const [index, status] of progression.entries()) {
            const timestamp = new Date(new Date(at).getTime() + index * 3600000).toISOString();
            const normalized = normalizeAfterShipTracking({ data: { tracking: {
                slug: afterShipCarrierSlug(carrier), tag: status,
                checkpoints: [{ tag: status, checkpoint_time: timestamp, message: `${carrier}: ${status}`, city: "Test City" }]
            } } });
            const event = { status: normalized.events[0].status, source: "AFTERSHIP", event_at: timestamp,
                safe_metadata: { carrier_scan: true } };
            const shopifyStatus = sync.mapCarrierEvent(event);
            assert.ok(shopifyStatus);
            const row = { id: index + 1, fulfillment_binding_id: 1, status: shopifyStatus, event_at: timestamp, attempts: 0 };
            const client = { async query(sql) {
                if (sql.startsWith("select o.*")) return { rows: [row] };
                if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
                if (sql.startsWith("select * from shopify_tracking_fulfillments")) return { rows: [binding] };
                if (sql.startsWith("select * from store_integrations")) return { rows: [integration] };
                if (sql.startsWith("select * from shopify_tracking_packages")) return { rows: [{ tracking_number: "TEST-PACKAGE", delivery_event_id: 1, confirmed_delivered_at: timestamp }] };
                return { rows: [] };
            } };
            assert.equal((await sync.processOne(client, { request })).state, "SENT");
            const input = { store, shipment, recipient: { email: "test@example.invalid" }, shopifySendState: "UNKNOWN",
                event: { status, eventAt: timestamp, location: "Test City", estimatedDelivery: "2026-09-18T18:00:00Z" }, sentKeys };
            const plan = evaluateDeliveryNotification(input);
            assert.equal(plan.notifications.length, 1);
            const notification = plan.notifications[0];
            sentKeys.add(notification.key);
            messages.push(notification);
            assert.match(notification.html, /href="https:\/\/tracking\.example\.invalid\/TEST-PACKAGE"/);
            assert.equal(notification.content.orderNumber, shipment.orderNumber);
            assert.equal(notification.to, "test@example.invalid");
            assert.equal(evaluateDeliveryNotification(input).notifications.length, 0);
            // Ambiguous acknowledgements reconcile existing Shopify events before retry.
            assert.equal((await sync.processOne(client, { request })).state, "SENT");
            assert.equal(remoteEvents.length, index + 1);
        }
        assert.deepEqual(remoteEvents.map((event) => event.status), ["CARRIER_PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]);
        assert.deepEqual(messages.map((message) => message.content.status), progression);
        assert.equal(remoteEvents.at(-1).happenedAt, messages.at(-1).content.eventAt);
    });
}
