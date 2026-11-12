const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    buildPortalKittingProcessingTiming,
    PORTAL_KITTING_MINIMUM_BUSINESS_DAYS
} = require("./server.js");

function functionSource(source, name, nextName) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start + 1);
    assert.notEqual(start, -1, `${name} was not found`);
    return source.slice(start, end === -1 ? source.length : end);
}

test("kitting minimum is four business days and skips the assigned warehouse holiday", () => {
    const timing = buildPortalKittingProcessingTiming({}, {
        now: new Date("2026-06-29T14:00:00.000Z"),
        location: {
            fulfillmentLocationId: "15",
            locationName: "Grey Wolf Main Warehouse",
            country: "Canada",
            state: "Ontario"
        }
    });

    assert.equal(PORTAL_KITTING_MINIMUM_BUSINESS_DAYS, 4);
    assert.equal(timing.earliestCompletionDate, "2026-07-06");
    assert.equal(timing.fulfillmentLocationId, "15");
    assert.deepEqual(timing.holidayClosures.map((holiday) => holiday.name), ["Canada Day"]);
    assert.match(timing.summary, /at least 4 business days/i);
    assert.match(timing.holidayWarning, /warehouse holiday affects this request/i);
});

test("kitting timing flags a requested completion date before the minimum", () => {
    const timing = buildPortalKittingProcessingTiming({ requestedCompletionDate: "2026-07-03" }, {
        now: new Date("2026-06-29T14:00:00.000Z"),
        location: { locationName: "Ontario Test Warehouse", country: "Canada", state: "Ontario" }
    });
    assert.equal(timing.earliestCompletionDate, "2026-07-06");
    assert.equal(timing.requestedBeforeEarliest, true);
});

test("customer kitting form makes the service commitment visible before submission", () => {
    const portal = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
    assert.match(portal, /Kitting requires at least 4 business days/);
    assert.match(portal, /id="kittingProcessingNotice"/);
    assert.match(portal, /id="kittingNeededBy" type="date" required/);
    assert.match(portal, /fulfillmentLocationId,/);
    assert.match(portal, /\/api\/portal\/kitting-timing/);
    assert.match(portal, /loadKittingTiming\(\{ silent: true \}\)\.catch\(\(\) => null\)/);
});

test("kitting persistence, notification, and reservations are warehouse scoped", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const reservation = functionSource(server, "reservePortalKittingComponents", "completePortalKittingInventory");
    assert.match(server, /portal_kitting_requests add column if not exists fulfillment_location_id/);
    assert.match(server, /earliest_completion_date/);
    assert.match(reservation, /b\.fulfillment_location_id = \$4/);
    assert.match(server, /fulfillmentLocationIds: request\.fulfillmentLocationId \? \[request\.fulfillmentLocationId\]/);
});
