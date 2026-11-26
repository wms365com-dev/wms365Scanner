const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNutemBookedNotification, sendNutemBookedNotification } = require("./server");

const booking = {
    id: "8", account_name: "ALCONA TRADING LTD", status: "CONFIRMED",
    ship_to_name: "NUTEM CUSTOM MANUFACTURING", ship_to_address1: "1105 Clay Ave",
    ship_to_postal_code: "L7L 0A1", po_number: "TEST-PO", order_code: "TEST-ORDER",
    appointment_date: "2026-12-04", window_start: "11:00:00", window_end: "11:30:00",
    recipient_email: "receiving@example.invalid",
    to_addresses: ["receiving@example.invalid"], cc_addresses: ["warehouse@example.invalid", "receiving@example.invalid"],
    bcc_addresses: ["private@example.invalid"], token_hash: "never-email-this"
};

test("booked email uses the saved envelope and booked window without a token", () => {
    const message = buildNutemBookedNotification(booking);
    assert.deepEqual(message.to, ["receiving@example.invalid"]);
    assert.deepEqual(message.cc, ["warehouse@example.invalid"]);
    assert.equal(message.bcc, undefined);
    assert.equal(message.deliveryKey, "order-routing-booked:8");
    assert.match(message.subject, /TEST-PO.*TEST-ORDER.*2026-12-04.*11:00-11:30 ET/);
    assert.doesNotMatch(JSON.stringify(message), /never-email-this|private@example\.invalid/);
});

test("unrelated, pending, and recipient-mismatched appointments cannot send", () => {
    for (const overrides of [
        { account_name: "ALCONA OTHER" }, { ship_to_address1: "11050 CLAY AVE" },
        { ship_to_postal_code: "L7L0A2" }, { status: "PENDING" }, { recipient_email: "wrong@example.invalid" }
    ]) assert.equal(buildNutemBookedNotification({ ...booking, ...overrides }), null);
});

test("the booking sender uses the verified original delivery and skips all delivery in sandbox", async (t) => {
    const key = "WMS365_SANDBOX_EXTERNAL_SIDE_EFFECTS_DISABLED";
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    const client = { async query(sql, params) {
        assert.match(sql, /e\.status='SENT'/);
        assert.match(sql, /e\.account_name=o\.account_name/);
        assert.match(sql, /routingRequestId/);
        assert.deepEqual(params, ["8"]);
        return { rowCount: 1, rows: [booking] };
    } };
    process.env[key] = "false";
    assert.equal(await sendNutemBookedNotification(client, "8", (mail) => mail.deliveryKey), "order-routing-booked:8");
    process.env[key] = "true";
    assert.deepEqual(await sendNutemBookedNotification(null, "8", () => assert.fail("unexpected send")), { skipped: true });
});
