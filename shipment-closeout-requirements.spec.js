const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_ORDER_DOCUMENT_CATEGORIES,
    sanitizePortalShippingConfirmationInput,
    assertPortalShipmentCloseoutReviewConfirmed,
    assertPortalShipmentProofRequirements,
    validatePortalShipmentLineConfirmations,
    buildPortalShipmentQuantityWarnings,
    buildPortalShipmentEmailText,
    buildPortalShipmentEmailHtml
} = require("./server");

const sampleOrder = {
    id: "101",
    orderCode: "ORD-TEST",
    lines: [
        { id: "11", sku: "SKU-A", quantity: 5 },
        { id: "12", sku: "SKU-B", quantity: 2 }
    ]
};

test("shipment closeout requires BOL, checked packing slip, and load photo", () => {
    assert.throws(
        () => assertPortalShipmentProofRequirements(
            {
                documents: [
                    { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_BOL },
                    { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_LOAD_PHOTO }
                ]
            },
            { shippedCarrierName: "Customer pickup", shippedTrackingReference: "BOL-123" }
        ),
        /checked packing slip/i
    );
});

test("shipment closeout requires packing slip quantity confirmation", () => {
    assert.throws(
        () => assertPortalShipmentCloseoutReviewConfirmed({ packingSlipQuantityConfirmed: false }),
        /packing slip quantity matches the system shipped quantity/i
    );
    assert.doesNotThrow(() => assertPortalShipmentCloseoutReviewConfirmed({ packingSlipQuantityConfirmed: true }));
});

test("shipment closeout accepts confirmation aliases from API payloads", () => {
    assert.equal(
        sanitizePortalShippingConfirmationInput({ packing_slip_quantity_confirmed: "yes" }).packingSlipQuantityConfirmed,
        true
    );
    assert.equal(
        sanitizePortalShippingConfirmationInput({ shipmentQuantityConfirmed: "false" }).packingSlipQuantityConfirmed,
        false
    );
});

test("parcel shipment closeout only requires tracking", () => {
    assert.doesNotThrow(() => assertPortalShipmentProofRequirements(
        { documents: [] },
        { shipmentMethod: "PARCEL", shippedCarrierName: "", shippedTrackingReference: "1Z123" }
    ));
});

test("parcel shipment closeout rejects missing tracking", () => {
    assert.throws(
        () => assertPortalShipmentProofRequirements(
            { documents: [] },
            { shipmentMethod: "PARCEL", shippedCarrierName: "UPS", shippedTrackingReference: "" }
        ),
        /parcel tracking number/i
    );
});

test("ltl shipment closeout still requires freight proof", () => {
    assert.throws(
        () => assertPortalShipmentProofRequirements(
            { documents: [] },
            { shipmentMethod: "LTL_FREIGHT", shippedCarrierName: "", shippedTrackingReference: "" }
        ),
        /signed BOL|checked packing slip|loaded freight/i
    );
});

test("ftl shipment closeout accepts freight proof without carrier or tracking", () => {
    assert.doesNotThrow(() => assertPortalShipmentProofRequirements(
        {
            documents: [
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_BOL },
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_PACKING_SLIP },
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_LOAD_PHOTO }
            ]
        },
        { shipmentMethod: "FTL_FREIGHT", shippedCarrierName: "", shippedTrackingReference: "" }
    ));
});

test("shipment closeout allows lower shipped quantity and records a warning", () => {
    const lines = validatePortalShipmentLineConfirmations(sampleOrder, [
        { orderLineId: "11", sku: "SKU-A", shippedQuantity: 5 },
        { orderLineId: "12", sku: "SKU-B", shippedQuantity: 1 }
    ], { required: true });

    assert.deepEqual(lines.map((line) => ({
        orderLineId: line.orderLineId,
        sku: line.sku,
        orderedQuantity: line.orderedQuantity,
        shippedQuantity: line.shippedQuantity
    })), [
        { orderLineId: 11, sku: "SKU-A", orderedQuantity: 5, shippedQuantity: 5 },
        { orderLineId: 12, sku: "SKU-B", orderedQuantity: 2, shippedQuantity: 1 }
    ]);
    assert.deepEqual(buildPortalShipmentQuantityWarnings(lines), [
        {
            orderLineId: 12,
            sku: "SKU-B",
            orderedQuantity: 2,
            shippedQuantity: 1,
            shortQuantity: 1,
            message: "SKU-B shipped 1 of 2."
        }
    ]);
});

test("shipment email highlights short shipped lines", () => {
    const shortOrder = {
        id: "101",
        orderCode: "ORD-SHORT",
        accountName: "TEST CUSTOMER",
        status: "SHIPPED",
        lines: [
            { id: "11", sku: "SKU-A", quantity: 5, trackingLevel: "UNIT", description: "Exact item", upc: "" },
            { id: "12", sku: "SKU-B", quantity: 2, trackingLevel: "UNIT", description: "Short item", upc: "" }
        ],
        shipmentLines: [
            { orderLineId: "11", sku: "SKU-A", orderedQuantity: 5, shippedQuantity: 5 },
            { orderLineId: "12", sku: "SKU-B", orderedQuantity: 2, shippedQuantity: 1 }
        ]
    };
    const confirmation = { documents: [] };

    const text = buildPortalShipmentEmailText(shortOrder, confirmation);
    const html = buildPortalShipmentEmailHtml(shortOrder, confirmation);

    assert.match(text, /SHORT SHIPMENT NOTICE/);
    assert.match(text, /SKU-B short 1 unit/);
    assert.match(text, /SKU-B \| Ordered: 2 units \| Shipped: 1 unit \| SHORT: 1 unit/);
    assert.match(html, /Short shipment notice/);
    assert.match(html, /background:#fef2f2/);
    assert.match(html, /color:#991b1b/);
    assert.match(html, /Short 1 unit/);
});

test("shipment closeout rejects shipped quantity above ordered quantity", () => {
    assert.throws(
        () => validatePortalShipmentLineConfirmations(sampleOrder, [
            { orderLineId: "11", sku: "SKU-A", shippedQuantity: 6 },
            { orderLineId: "12", sku: "SKU-B", shippedQuantity: 2 }
        ], { required: true }),
        /cannot be greater than the order quantity/i
    );
});

test("shipment closeout accepts all proof and exact shipped quantities", () => {
    assert.doesNotThrow(() => assertPortalShipmentProofRequirements(
        {
            documents: [
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_BOL },
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_PACKING_SLIP },
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_LOAD_PHOTO }
            ]
        },
        { shippedCarrierName: "LTL Carrier", shippedTrackingReference: "PRO-456" }
    ));

    const lines = validatePortalShipmentLineConfirmations(sampleOrder, [
        { orderLineId: "11", sku: "SKU-A", shippedQuantity: 5 },
        { orderLineId: "12", sku: "SKU-B", shippedQuantity: 2 }
    ], { required: true });

    assert.deepEqual(lines.map((line) => ({
        orderLineId: line.orderLineId,
        sku: line.sku,
        orderedQuantity: line.orderedQuantity,
        shippedQuantity: line.shippedQuantity
    })), [
        { orderLineId: 11, sku: "SKU-A", orderedQuantity: 5, shippedQuantity: 5 },
        { orderLineId: 12, sku: "SKU-B", orderedQuantity: 2, shippedQuantity: 2 }
    ]);
});
