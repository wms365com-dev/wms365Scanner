const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_ORDER_DOCUMENT_CATEGORIES,
    sanitizePortalShippingConfirmationInput,
    assertPortalShipmentCloseoutReviewConfirmed,
    assertPortalShipmentProofRequirements,
    validatePortalShipmentLineConfirmations,
    buildPortalShipmentQuantityWarnings,
    splitShipmentTrackingReferences,
    buildCarrierTrackingUrl,
    extractPortalParcelTrackingFromText,
    extractPortalShippingLabelDetailsFromDocuments,
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

test("shipping label extractor captures parcel shipment type and all Purolator PINs", () => {
    const details = extractPortalParcelTrackingFromText(`
        PUROLATOR EXPRESS
        PUROLATOR PIN: 520641667354
        PUROLATOR PIN: 520641667362
        PUROLATOR PIN: 520641667370
        PUROLATOR PIN: 520641667388
    `);

    assert.equal(details.shipmentMethod, "PARCEL");
    assert.equal(details.shippedCarrierName, "Purolator");
    assert.deepEqual(details.trackingNumbers, [
        "520641667354",
        "520641667362",
        "520641667370",
        "520641667388"
    ]);
    assert.equal(details.shippedTrackingReference, "520641667354, 520641667362, 520641667370, 520641667388");
});

test("shipping label document extraction treats readable label uploads as parcel shipments", () => {
    const details = extractPortalShippingLabelDetailsFromDocuments([
        {
            fileName: "Shipping Labels.pdf",
            fileType: "application/pdf",
            fileBuffer: Buffer.from("UPS TRACKING 1ZV56D262012289736", "utf8")
        }
    ]);

    assert.equal(details.shipmentMethod, "PARCEL");
    assert.equal(details.shippedCarrierName, "UPS");
    assert.equal(details.shippedTrackingReference, "1ZV56D262012289736");
});

test("shipment email lists multiple tracking numbers and customer label support note", () => {
    const order = {
        id: "101",
        orderCode: "ORD-LABEL",
        accountName: "TEST CUSTOMER",
        status: "SHIPPED",
        lines: [
            { id: "11", sku: "SKU-A", quantity: 1, trackingLevel: "CASE", description: "Exact item", upc: "" }
        ],
        shipmentLines: [
            { orderLineId: "11", sku: "SKU-A", orderedQuantity: 1, shippedQuantity: 1 }
        ]
    };
    const confirmation = {
        shipmentMethod: "PARCEL",
        shippedCarrierName: "Purolator",
        shippedTrackingReference: "520641667354, 520641667362",
        documents: [
            {
                fileName: "Shipping Labels.pdf",
                documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPPING_LABEL,
                uploadedBy: "customer@example.com"
            }
        ]
    };

    const text = buildPortalShipmentEmailText(order, confirmation);
    const html = buildPortalShipmentEmailHtml(order, confirmation);

    assert.deepEqual(splitShipmentTrackingReferences(confirmation.shippedTrackingReference), [
        "520641667354",
        "520641667362"
    ]);
    assert.match(text, /Shipment Type: Parcel/);
    assert.match(text, /Tracking Numbers:/);
    assert.match(text, /520641667354/);
    assert.match(text, /https:\/\/www\.purolator\.com\/en\/shipping\/tracker\?pins=520641667354/);
    assert.match(text, /customer-provided label note/i);
    assert.match(text, /contact the carrier or the account that created the label directly/i);
    assert.match(html, /Shipment Type/);
    assert.match(html, /href="https:\/\/www\.purolator\.com\/en\/shipping\/tracker\?pins=520641667354"/);
    assert.match(html, />520641667354<\/a>/);
    assert.match(html, /Customer-provided shipping label/);
});

test("carrier tracking URLs are generated for recognized parcel carriers", () => {
    assert.equal(
        buildCarrierTrackingUrl("Purolator", "520641667354"),
        "https://www.purolator.com/en/shipping/tracker?pins=520641667354"
    );
    assert.equal(
        buildCarrierTrackingUrl("UPS", "1ZV56D262012289736"),
        "https://www.ups.com/track?tracknum=1ZV56D262012289736"
    );
    assert.equal(
        buildCarrierTrackingUrl("Canpar", "D420352470002433984001"),
        "https://www.canpar.com/en/tracking/track.htm?barcode=D420352470002433984001"
    );
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
