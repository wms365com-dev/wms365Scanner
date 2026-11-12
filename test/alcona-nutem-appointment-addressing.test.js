const assert = require("node:assert/strict");
const test = require("node:test");
const { TO, CC, BCC, isNutem } = require("../scripts/send-alcona-nutem-second-appointment-reminders");

test("Nutem appointment reminders use visible To and approved CC only", () => {
    assert.deepEqual(TO, ["shipping.receiving@nutem.com"]);
    assert.deepEqual(CC, [
        "smit@alconatradingltd.ca",
        "d.jain@emotrans-canada.com",
        "prathab@greywolf3pl.com",
        "gworders@greywolf3pl.com"
    ]);
    assert.deepEqual(BCC, []);
});

test("Nutem scope requires exact destination identity", () => {
    assert.equal(isNutem({
        ship_to_name: "NUTEM CUSTOM MANUFACTURING",
        ship_to_address1: "1105 CLAY AVE",
        ship_to_postal_code: "L7L 0A1"
    }), true);
    assert.equal(isNutem({
        ship_to_name: "NUTEM CUSTOM MANUFACTURING",
        ship_to_address1: "1106 CLAY AVE",
        ship_to_postal_code: "L7L 0A1"
    }), false);
    assert.equal(isNutem({
        ship_to_name: "OTHER COMPANY",
        ship_to_address1: "1105 CLAY AVE",
        ship_to_postal_code: "L7L 0A1"
    }), false);
});
