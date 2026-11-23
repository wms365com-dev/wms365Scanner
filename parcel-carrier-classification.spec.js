const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeTrackingCarrier } = require("./carrier-tracking");
const {
    assertShipmentMethodMatchesTrackingReference,
    buildCarrierTrackingUrl,
    classifyParcelTrackingReference
} = require("./server");

test("ICS Standard is treated as ICS Courier parcel service", () => {
    assert.equal(normalizeTrackingCarrier("ICS Standard"), "ICS_COURIER");
    assert.deepEqual(classifyParcelTrackingReference("ND6C2BV3PNHFR5N7L2X8", "ICS Standard"), {
        isParcel: true,
        carrier: "ICS Courier",
        reference: "ND6C2BV3PNHFR5N7L2X8"
    });
    assert.equal(
        buildCarrierTrackingUrl("ICS Standard", "ND6C2BV3PNHFR5N7L2X8"),
        "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=ND6C2BV3PNHFR5N7L2X8"
    );
});

test("carrier service levels retain their canonical tracking provider", () => {
    assert.equal(normalizeTrackingCarrier("GLS Ground"), "GLS");
    assert.equal(normalizeTrackingCarrier("UPS Standard"), "UPS");
    assert.equal(normalizeTrackingCarrier("Canpar Ground"), "CANPAR");
    assert.equal(normalizeTrackingCarrier("Purolator Ground"), "PUROLATOR");
});

test("the server blocks an ICS parcel reference from being saved as LTL", () => {
    assert.throws(() => assertShipmentMethodMatchesTrackingReference({
        shipmentMethod: "LTL_FREIGHT",
        carrierName: "ICS Standard",
        trackingReference: "ND6C2BV3PNHFR5N7L2X8"
    }), /ICS Courier parcel tracking/i);
    assert.doesNotThrow(() => assertShipmentMethodMatchesTrackingReference({
        shipmentMethod: "PARCEL",
        carrierName: "ICS Standard",
        trackingReference: "ND6C2BV3PNHFR5N7L2X8"
    }));
});

test("freight-branded carrier services are not silently treated as parcel", () => {
    assert.equal(classifyParcelTrackingReference("P062563", "FedEx Freight").isParcel, false);
});

test("the warehouse form automatically changes known parcel carriers to Parcel", () => {
    const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.match(desktop, /function isKnownParcelCarrier/);
    assert.match(desktop, /shipmentCarrierInput\) updatePortalShipmentCarrierMethod/);
    assert.match(desktop, /select\.value = "PARCEL"/);
    assert.match(desktop, /Shipment Type changed to Parcel because/);
    assert.match(desktop, /\/\^UPS\(\?:\\s\|\$\)\|UNITED PARCEL\//);
});
