const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildPortalReleaseEmailText,
    buildPortalReleaseEmailHtml
} = require("./server");

const sampleReleasedOrder = {
    id: "101",
    orderCode: "ORD-TEST",
    accountName: "TEST COMPANY",
    status: "RELEASED",
    poNumber: "PO-123",
    shippingReference: "REF-123",
    requestedShipDate: "2026-06-13",
    contactName: "Customer Contact",
    contactPhone: "555-0100",
    shipToName: "Ship To Name",
    shipToAddress1: "123 Test Street",
    shipToCity: "Toronto",
    shipToState: "ON",
    shipToPostalCode: "M1M 1M1",
    shipToCountry: "Canada",
    orderNotes: "Handle carefully",
    lines: [
        {
            sku: "SKU-SHOULD-NOT-BE-IN-EMAIL",
            description: "Line detail should stay in WMS365",
            quantity: 4,
            trackingLevel: "CASE",
            upc: "123456789012",
            pickLocations: [{ location: "BULK", quantity: 4, trackingLevel: "CASE" }]
        }
    ]
};

test("warehouse release email is notification-only without pick lines or document filenames", () => {
    const text = buildPortalReleaseEmailText(sampleReleasedOrder, {
        ccRecipients: ["warehouse@example.com"],
        orderDocumentAttachments: [{ filename: "customer-label.pdf" }]
    });
    const html = buildPortalReleaseEmailHtml(sampleReleasedOrder, {
        orderDocumentAttachments: [{ filename: "customer-label.pdf" }]
    });

    assert.match(text, /WMS365 ORDER RELEASED: ORD-TEST/);
    assert.match(text, /No order documents are attached to this notification\./);
    assert.match(text, /Open WMS365: .*\/desktop\?section=orders/);
    assert.doesNotMatch(text, /SKU-SHOULD-NOT-BE-IN-EMAIL/);
    assert.doesNotMatch(text, /customer-label\.pdf/);
    assert.doesNotMatch(text, /pick-ticket\.pdf/);
    assert.doesNotMatch(text, /Pick Lines:/);

    assert.match(html, /Warehouse Order Notification/);
    assert.match(html, /Open WMS365/);
    assert.doesNotMatch(html, /SKU-SHOULD-NOT-BE-IN-EMAIL/);
    assert.doesNotMatch(html, /customer-label\.pdf/);
    assert.doesNotMatch(html, /pick-ticket\.pdf/);
    assert.doesNotMatch(html, /Pick Lines/);
});
