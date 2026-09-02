const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    subtractPortalBusinessDays,
    getOrderRoutingReadinessMissingFields,
    getOrderRoutingReadinessSchedule,
    buildOrderRoutingReadinessDeliveryKey,
    buildOrderRoutingReadinessEmailText,
    buildOrderRoutingReadinessEmailHtml
} = require("./server");

const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const location = {
    id: "143",
    code: "WHS01",
    name: "Grey Wolf Edwards Warehouse",
    country: "Canada",
    state: "Ontario"
};
const baseOrder = {
    id: "615",
    orderCode: "ORD-000615",
    accountName: "TEST COMPANY",
    status: "RELEASED",
    poNumber: "TEST-PO-615",
    requestedShipDate: "2026-09-04",
    shipmentMethod: "LTL_FREIGHT",
    fulfillmentLocationId: "143",
    routingEmail: "",
    outboundPallets: { totalPalletsOut: 0 },
    pickedPalletDetails: [],
    routingTotalWeight: null,
    routedAt: null
};

test("routing preparation date is two warehouse business days before delivery", () => {
    assert.equal(subtractPortalBusinessDays("2026-09-04", 2, location), "2026-09-02");
});

test("routing preparation skips weekends and the assigned warehouse holiday calendar", () => {
    assert.equal(subtractPortalBusinessDays("2026-09-09", 2, location), "2026-09-04");
});

test("freight reminder becomes eligible during its two-business-day preparation window", () => {
    const schedule = getOrderRoutingReadinessSchedule(baseOrder, {
        now: new Date("2026-09-02T14:00:00.000Z"),
        location
    });
    assert.equal(schedule.eligible, true);
    assert.equal(schedule.reminderDate, "2026-09-02");
    assert.equal(schedule.deliveryDate, "2026-09-04");
});

test("parcel, routed, draft, and past-delivery orders do not receive routing reminders", () => {
    const now = new Date("2026-09-02T14:00:00.000Z");
    assert.equal(getOrderRoutingReadinessSchedule({ ...baseOrder, shipmentMethod: "PARCEL" }, { now, location }).eligible, false);
    assert.equal(getOrderRoutingReadinessSchedule({ ...baseOrder, routedAt: now.toISOString() }, { now, location }).eligible, false);
    assert.equal(getOrderRoutingReadinessSchedule({ ...baseOrder, status: "DRAFT" }, { now, location }).eligible, false);
    assert.equal(getOrderRoutingReadinessSchedule({ ...baseOrder, requestedShipDate: "2026-09-01" }, { now, location }).eligible, false);
});

test("readiness lists staging, routing contact, pallets, and weight without auto-staging", () => {
    assert.deepEqual(getOrderRoutingReadinessMissingFields(baseOrder), [
        "Complete the physical pick and move the order to STAGED",
        "Routing email",
        "Total pallet count",
        "Pallet weights and total shipment weight"
    ]);
    assert.deepEqual(getOrderRoutingReadinessMissingFields({
        ...baseOrder,
        status: "STAGED",
        routingEmail: "routing@example.org",
        outboundPallets: { totalPalletsOut: 4 },
        routingTotalWeight: 4200
    }), []);
});

test("reminder content is explicit about physical work and the one-time routing safeguard", () => {
    const schedule = getOrderRoutingReadinessSchedule(baseOrder, {
        now: new Date("2026-09-02T14:00:00.000Z"),
        location
    });
    const text = buildOrderRoutingReadinessEmailText(baseOrder, location, schedule);
    const html = buildOrderRoutingReadinessEmailHtml(baseOrder, location, schedule);
    assert.match(text, /Physically pick the order/i);
    assert.match(text, /STAGED only after the freight is physically staged/i);
    assert.match(text, /can only be sent once/i);
    assert.match(html, /Warehouse action required/i);
    assert.match(html, /Grey Wolf Edwards Warehouse/i);
});

test("delivery key prevents duplicate reminders while allowing a changed delivery date", () => {
    assert.equal(
        buildOrderRoutingReadinessDeliveryKey(baseOrder, location, "2026-09-04"),
        "order-routing-readiness:615:143:2026-09-04"
    );
    assert.notEqual(
        buildOrderRoutingReadinessDeliveryKey(baseOrder, location, "2026-09-04"),
        buildOrderRoutingReadinessDeliveryKey(baseOrder, location, "2026-09-08")
    );
});

test("scheduler uses warehouse-only BCC recipients and never customer CC fields", () => {
    assert.match(serverSource, /join app_user_fulfillment_location_access access on access\.app_user_id = u\.id/);
    assert.match(serverSource, /from portal_vendor_access customer_access/);
    assert.match(serverSource, /customer_access\.is_active = true/);
    assert.match(serverSource, /sourceType: "ORDER_ROUTING_READINESS"/);
    assert.match(serverSource, /bcc: recipients\.filter/);
    assert.doesNotMatch(serverSource, /sendOrderRoutingReadinessReminder[\s\S]{0,2500}bccRecipients/);
    assert.match(serverSource, /ensureOrderRoutingReadinessSchedulerStarted\(\)/);
});
