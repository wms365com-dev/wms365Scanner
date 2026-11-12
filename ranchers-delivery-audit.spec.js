"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, deliveryRow, fulfillmentDeliveryMismatch } = require("./scripts/audit-ranchers-carrier-deliveries-readonly");

test("carrier evidence retains local timestamps without guessing UTC", () => {
    for (const [carrier, rows] of [
        ["ICS", [["2026-09-14 11:57:02", "Delivered at: Recipient"]]],
        ["CANPAR", [["2026-09-16 17:11:43", "Our Package was Delivered", "TERMINAL", ""]]],
        ["GLS", [["Delivered\nYour shipment was delivered.", "TERMINAL", "9/16/2026", "12:00:15 PM"]]]
    ]) {
        const evidence = deliveryRow(carrier, rows);
        assert.equal(evidence.status, "DELIVERED");
        assert.equal(evidence.timezoneVerified, false);
        assert.equal(evidence.eventAt, undefined);
        assert.ok(!JSON.stringify(evidence).includes("Recipient"));
    }
});
test("ETA, summary labels, failed attempts and missing times are not delivery scans", () => {
    assert.equal(deliveryRow("ICS", [["2026-09-14", "Delivered at: Recipient"]]), null);
    assert.equal(deliveryRow("ICS", [["2026-09-14 11:57:02", "Expected delivery"]]), null);
    assert.equal(deliveryRow("CANPAR", [["2026-09-16 17:11:43", "Delivery attempted", "TERMINAL"]]), null);
    assert.equal(deliveryRow("CANPAR", [["2026-09-16 17:11:43", "Delivered", "TERMINAL"]]), null);
    assert.equal(deliveryRow("GLS", [["Delivered", "TERMINAL", "9/16/2026", "12:00:15 PM"]]), null);
});
test("verified GLS front-door wording remains a dated actual delivery scan", () => {
    assert.equal(deliveryRow("GLS", [["Delivered\nYour shipment was delivered at the front door.", "TERMINAL", "9/17/2026", "9:23:18 AM"]]).status, "DELIVERED");
    assert.equal(deliveryRow("GLS", [["Delivered\nYour shipment was delivered to the mailbox.", "TERMINAL", "9/17/2026", "9:23:18 AM"]]).status, "DELIVERED");
    assert.equal(deliveryRow("GLS", [["Delivered\nYour shipment was delivered and we received a signature.", "TERMINAL", "9/17/2026", "9:23:18 AM"]]).status, "DELIVERED");
    assert.equal(deliveryRow("GLS", [["Delivered\nYour shipment was delivered in the garage.", "TERMINAL", "9/17/2026", "9:23:18 AM"]]).status, "DELIVERED");
    assert.equal(deliveryRow("GLS", [["Delivered\nYour shipment will be delivered at the front door.", "TERMINAL", "9/17/2026", "9:23:18 AM"]]), null);
});
test("only the intended Canadian carrier names are classified", () => {
    assert.equal(classify("ICS Ground"), "ICS");
    assert.equal(classify("Canpar Courier"), "CANPAR");
    assert.equal(classify("GLS Ground"), "GLS");
    assert.equal(classify("UPS"), null);
    assert.equal(classify("Fake GLS"), null);
});
test("an older delivered scan cannot override a later return or exception", () => {
    assert.equal(deliveryRow("ICS", [["2026-09-16 12:00:00", "Returned"], ["2026-09-14 12:00:00", "Delivered at: Recipient"]]), null);
    assert.equal(deliveryRow("CANPAR", [["2026-09-16 12:00:00", "Returned", "TERMINAL"], ["2026-09-14 12:00:00", "Our Package was Delivered", "TERMINAL"]]), null);
    assert.equal(deliveryRow("GLS", [["Returned", "TERMINAL", "9/16/2026", "12:00:00 PM"], ["Delivered\nYour shipment was delivered.", "TERMINAL", "9/14/2026", "12:00:00 PM"]]), null);
});
test("shared fulfillment requires real delivery evidence for every unique package", () => {
    const f = { status: "SUCCESS", displayStatus: "FULFILLED", trackingInfo: [{ company: "ICS Ground", number: "A" }, { company: "Canpar", number: "B" }] };
    const delivered = (carrier, number) => ({ carrier, number, result: "CARRIER_CONFIRMED_DELIVERED", evidence: { status: "DELIVERED" } });
    const packages = [delivered("ICS", "A"), delivered("CANPAR", "B")];
    assert.equal(fulfillmentDeliveryMismatch(f, packages), true);
    assert.equal(fulfillmentDeliveryMismatch(f, packages.slice(0, 1)), false);
    assert.equal(fulfillmentDeliveryMismatch(f, [...packages, delivered("ICS", "A")]), false);
    assert.equal(fulfillmentDeliveryMismatch(f, [delivered("ICS", "A"), delivered("GLS", "B")]), false);
    assert.equal(fulfillmentDeliveryMismatch({ ...f, displayStatus: "DELIVERED" }, packages), false);
    assert.equal(fulfillmentDeliveryMismatch({ ...f, status: "CANCELLED" }, packages), false);
    assert.equal(fulfillmentDeliveryMismatch({ ...f, trackingInfo: [] }, packages), false);
    assert.equal(fulfillmentDeliveryMismatch(f, packages.map((p) => ({ ...p, result: "CHECK_FAILED" }))), false);
});
