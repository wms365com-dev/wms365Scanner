const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildWarehouseBillingActivityEmailText,
    buildWarehouseBillingActivityEmailHtml,
    DEFAULT_WAREHOUSE_BILLING_CONTACT_NAME,
    DEFAULT_WAREHOUSE_BILLING_CONTACT_EMAIL
} = require("./server.js");

test("warehouse billing activity email includes invoice-ready details", () => {
    const activity = {
        activityType: "ORDER_SHIPPED",
        accountName: "TEST CUSTOMER",
        sourceRef: "ORD-TEST",
        document: {
            accountName: "TEST CUSTOMER",
            orderCode: "ORD-TEST",
            poNumber: "PO-123",
            requestedShipDate: "2026-07-24",
            confirmedShipDate: "2026-07-24",
            shipmentMethod: "LTL_FREIGHT",
            shippedCarrierName: "Test Carrier",
            shippedTrackingReference: "PRO123",
            fulfillmentLocationCode: "GW3PL-MEADOWPINE",
            fulfillmentLocationName: "Grey Wolf 3PL & Logistics Inc - Meadowpine",
            lines: [
                { sku: "SKU-1", quantity: 4, trackingLevel: "PALLET", description: "Test product" }
            ]
        }
    };
    const warehouse = {
        code: "GW3PL-MEADOWPINE",
        name: "Grey Wolf 3PL & Logistics Inc - Meadowpine",
        billingContactName: DEFAULT_WAREHOUSE_BILLING_CONTACT_NAME,
        billingContactEmail: DEFAULT_WAREHOUSE_BILLING_CONTACT_EMAIL,
        address1: "2425 Meadowpine Blvd",
        city: "Mississauga",
        state: "Ontario",
        postalCode: "L5N 6L7",
        country: "Canada"
    };
    const events = [
        {
            id: "100",
            feeCode: "PALLET_PICK_FEE",
            feeName: "Pallet pick fee",
            unitLabel: "pallet",
            quantity: 4,
            rate: 6,
            amount: 24,
            currencyCode: "CAD",
            serviceDate: "2026-07-24"
        }
    ];

    const text = buildWarehouseBillingActivityEmailText(activity, warehouse, events);
    const html = buildWarehouseBillingActivityEmailHtml(activity, warehouse, events);

    assert.match(text, /Invoice action: please invoice the customer today/);
    assert.match(text, /TEST CUSTOMER/);
    assert.match(text, /ORD-TEST/);
    assert.match(text, /GW3PL-MEADOWPINE/);
    assert.match(text, /PALLET_PICK_FEE/);
    assert.match(text, /CA\$24\.00/);
    assert.match(html, /Billable warehouse activity is complete/);
    assert.match(html, /PALLET_PICK_FEE/);
});
