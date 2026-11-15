"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    getPortalOrderBillOfLadingReadiness,
    getPortalOrderBolShipmentEntries,
    sanitizePortalOrderInput
} = require("./server");

function stagedOrder(overrides = {}) {
    return {
        id: "1",
        orderCode: "ORD-TEST-1",
        accountName: "BISON TRANSPORT TEST COMPANY",
        status: "STAGED",
        poNumber: "TEST-PO",
        shipmentMethod: "LTL_FREIGHT",
        plannedCarrierName: "Test Carrier",
        plannedServiceLevel: "Standard LTL",
        shipToName: "Test Receiver",
        shipToAddress1: "1 Test Street",
        shipToCity: "Test City",
        shipToState: "ON",
        shipToPostalCode: "A1A1A1",
        shipToCountry: "Canada",
        requestedShipDate: "2026-11-16",
        routingTotalWeight: 100,
        routingWeightUom: "LB",
        outboundPallets: { totalPalletsOut: 1 },
        fulfillmentLocationId: "1",
        fulfillmentLocationCode: "TEST-WH",
        fulfillmentLocationName: "Test Warehouse",
        fulfillmentAddress1: "10 Warehouse Road",
        fulfillmentCity: "Test City",
        fulfillmentState: "ON",
        fulfillmentPostalCode: "A1A1A1",
        fulfillmentCountry: "Canada",
        lines: [{ sku: "TEST-SKU", quantity: 1 }],
        ...overrides
    };
}

test("planned fulfillment fields are sanitized independently from final shipment fields", () => {
    const value = sanitizePortalOrderInput({
        shipmentMethod: "FTL_FREIGHT",
        plannedCarrierName: "  Bison Transport  ",
        plannedServiceLevel: "  Expedited  "
    }, "BISON TRANSPORT TEST COMPANY");
    assert.equal(value.shipmentMethod, "FTL_FREIGHT");
    assert.equal(value.plannedCarrierName, "Bison Transport");
    assert.equal(value.plannedServiceLevel, "Expedited");
    assert.equal(Object.hasOwn(value, "shippedCarrierName"), false);
});

test("BOL uses planned carrier until a final shipment carrier exists", () => {
    const planned = getPortalOrderBolShipmentEntries(stagedOrder())[0];
    assert.equal(planned.carrier, "Test Carrier");
    assert.equal(planned.serviceLevel, "Standard LTL");

    const final = getPortalOrderBolShipmentEntries(stagedOrder({ shippedCarrierName: "Final Carrier" }))[0];
    assert.equal(final.carrier, "Final Carrier");
});

test("customer pickup does not require a fabricated delivery address", () => {
    const readiness = getPortalOrderBillOfLadingReadiness(stagedOrder({
        shipmentMethod: "CUSTOMER_PICKUP",
        plannedCarrierName: "",
        shipToAddress1: "",
        shipToCity: "",
        shipToState: "",
        shipToPostalCode: "",
        shipToCountry: ""
    }));
    assert.equal(readiness.ready, true);
    assert.equal(readiness.missingFields.some((field) => field.startsWith("Ship-to")), false);
    assert.equal(readiness.shipments[0].carrier, "Customer Pickup");
});

test("delivery methods remain blocked when destination fields are missing", () => {
    const readiness = getPortalOrderBillOfLadingReadiness(stagedOrder({
        shipToAddress1: "",
        shipToCity: "",
        shipToState: "",
        shipToPostalCode: "",
        shipToCountry: ""
    }));
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missingFields.filter((field) => field.startsWith("Ship-to")), [
        "Ship-to street address",
        "Ship-to city",
        "Ship-to province/state",
        "Ship-to postal/ZIP code",
        "Ship-to country"
    ]);
});

