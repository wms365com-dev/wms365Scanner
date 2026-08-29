const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildCarrierTrackingUrl } = require("./server");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("builds tracking links for major Canadian parcel carriers", () => {
    assert.match(buildCarrierTrackingUrl("Purolator", "123456789012"), /purolator\.com/);
    assert.match(buildCarrierTrackingUrl("Canada Post", "1234567890123456"), /canadapost-postescanada\.ca/);
    assert.match(buildCarrierTrackingUrl("Dragonfly (Intelcom)", "INT123"), /dragonflyshipping\.com/);
});

test("opens official tracking pages for Canadian LTL carriers", () => {
    assert.equal(buildCarrierTrackingUrl("Day & Ross", "A01234567"), "https://dayross.com/en/track-shipments");
    assert.equal(buildCarrierTrackingUrl("Manitoulin Transport", "PRO123"), "https://manitoulintransport.com/track-shipment/");
    assert.equal(buildCarrierTrackingUrl("Midland Transport", "PRO456"), "https://legacy.midlandtransport.com/Home.aspx");
});

test("shipment carrier dropdown includes Grey Wolf regional carriers", () => {
    assert.match(desktop, /"Truck 4 Delivery"/);
    assert.match(desktop, /"Bison Transport"/);
});
