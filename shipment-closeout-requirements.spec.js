const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_ORDER_DOCUMENT_CATEGORIES,
    assertPortalShipmentProofRequirements,
    validatePortalShipmentLineConfirmations
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

test("shipment closeout rejects shipped quantity mismatch", () => {
    assert.throws(
        () => validatePortalShipmentLineConfirmations(sampleOrder, [
            { orderLineId: "11", sku: "SKU-A", shippedQuantity: 5 },
            { orderLineId: "12", sku: "SKU-B", shippedQuantity: 1 }
        ], { required: true }),
        /ordered for 2.*shipped quantity.*1/i
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
