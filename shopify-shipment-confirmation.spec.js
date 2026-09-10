const test = require("node:test");
const assert = require("node:assert/strict");

const { buildShopifyShipmentActivityDetails } = require("./server");

test("Shopify shipment activity includes the shipped carrier and tracking", () => {
    const detail = buildShopifyShipmentActivityDetails(
        {
            accountName: "TEST COMPANY",
            shippedCarrierName: "GLS Ground",
            shippedTrackingReference: "TEST-TRACKING-123"
        },
        {
            integration_name: "Test Shopify"
        },
        "TEST-ORDER-456"
    );

    assert.match(detail, /Carrier GLS Ground/);
    assert.match(detail, /Tracking TEST-TRACKING-123/);
    assert.match(detail, /External order TEST-ORDER-456/);
    assert.match(detail, /Marked shipped/);
});
