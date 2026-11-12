const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    getInboundFollowupType,
    isDeliverableInboundCreatorEmail,
    buildPortalInboundFollowupEmailText,
    buildPortalInboundFollowupEmailHtml
} = require("./server");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const inbound = {
    id: 123,
    inboundCode: "INB-000123",
    accountName: "TEST COMPANY",
    referenceNumber: "PO-100",
    carrierName: "Test Carrier",
    expectedDate: "2026-08-01",
    creatorEmail: "creator@example.com",
    creatorName: "creator",
    fulfillmentLocationCode: "WHS01",
    fulfillmentLocationName: "Grey Wolf Edwards",
    lineCount: 3
};

test("inbound follow-up timing sends one day-before reminder", () => {
    assert.equal(
        getInboundFollowupType("2026-08-01", { now: new Date("2026-07-31T14:00:00.000Z") }),
        "PRE_ARRIVAL"
    );
});

test("inbound follow-up timing identifies overdue shipments", () => {
    assert.equal(
        getInboundFollowupType("2026-07-29", { now: new Date("2026-07-30T14:00:00.000Z") }),
        "OVERDUE"
    );
    assert.equal(
        getInboundFollowupType("2026-07-30", { now: new Date("2026-07-30T14:00:00.000Z") }),
        ""
    );
});

test("pre-arrival email asks the creator to confirm carrier and inbound details", () => {
    const text = buildPortalInboundFollowupEmailText(inbound, "PRE_ARRIVAL");
    const html = buildPortalInboundFollowupEmailHtml(inbound, "PRE_ARRIVAL");
    assert.match(text, /expected tomorrow/i);
    assert.match(text, /confirm with the shipper or carrier/i);
    assert.match(text, /confirm that the inbound information is correct/i);
    assert.match(text, /automated WMS365 planning email/i);
    assert.match(html, /Grey Wolf Edwards/);
});

test("overdue email asks the creator to follow up and update WMS365", () => {
    const text = buildPortalInboundFollowupEmailText(inbound, "OVERDUE");
    assert.match(text, /has not been marked as arrived/i);
    assert.match(text, /follow up with the shipper or carrier/i);
    assert.match(text, /update the expected arrival date or arrival status in WMS365/i);
});

test("scheduler deduplicates by inbound, reminder type, and expected date", () => {
    assert.match(serverSource, /unique \(inbound_id, notification_type, expected_date\)/);
    assert.match(serverSource, /on conflict \(inbound_id, notification_type, expected_date\)/);
    assert.match(serverSource, /where i\.status = 'SUBMITTED'/);
    assert.match(serverSource, /and i\.arrived_at is null/);
});

test("scheduler excludes disabled portal creators and records warehouse creator emails", () => {
    assert.match(serverSource, /left join portal_vendor_access pva on pva\.id = i\.portal_access_id and pva\.is_active = true/);
    assert.match(serverSource, /creatorEmail: appUser\?\.email \|\| ""/);
});

test("scheduler skips placeholder creator addresses", () => {
    assert.equal(isDeliverableInboundCreatorEmail("creator@example.com"), false);
    assert.equal(isDeliverableInboundCreatorEmail("creator@test.com"), false);
    assert.equal(isDeliverableInboundCreatorEmail("creator@customer.ca"), true);
});
