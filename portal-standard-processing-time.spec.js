const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const { buildPortalOrderProcessingTiming } = require("./server.js");

test("all customer portals use a four-business-day standard non-parcel commitment", () => {
    assert.match(portalHtml, /const PORTAL_STANDARD_MINIMUM_BUSINESS_DAYS = 4/);
    assert.match(portalHtml, /Standard non-parcel processing requires a minimum of 4 business days/);
    assert.doesNotMatch(portalHtml, /48 hours \/ 2 business days/);
    assert.doesNotMatch(serverSource, /48 hours \/ 2 business days/);
});

test("standard ready dates use four warehouse business days", () => {
    const timing = buildPortalOrderProcessingTiming({
        status: "DRAFT",
        createdAt: "2026-07-15T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        fulfillmentCountry: "Canada",
        fulfillmentState: "Ontario",
        requestedShipDate: "2026-07-20"
    }, { now: new Date("2026-07-15T14:00:00.000Z") });

    assert.equal(timing.expectedReadyDate, "2026-07-21");
    assert.equal(timing.requestedBeforeReady, true);
    assert.equal(timing.rushRequired, true);
    assert.match(timing.summary, /minimum of 4 business days/i);
});

test("online parcel orders retain their separate parcel processing cycle", () => {
    const timing = buildPortalOrderProcessingTiming({
        status: "DRAFT",
        createdAt: "2026-07-15T12:00:00.000Z",
        orderType: "B2C_ONLINE",
        shipmentMethod: "PARCEL",
        fulfillmentCountry: "Canada",
        fulfillmentState: "Ontario",
        requestedShipDate: "2026-07-15"
    }, { now: new Date("2026-07-15T12:00:00.000Z") });

    assert.equal(timing.isOnlineParcel, true);
    assert.equal(timing.rushRequired, false);
    assert.match(timing.summary, /same-day parcel cycle/i);
});
