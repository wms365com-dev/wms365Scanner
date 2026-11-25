const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
    APP_USER_ROLES,
    PORTAL_ORDER_DOCUMENT_CATEGORIES,
    sanitizePortalShippingConfirmationInput,
    assertPortalShipmentCloseoutReviewConfirmed,
    assertPortalShipmentProofRequirements,
    validatePortalShipmentLineConfirmations,
    buildPortalShipmentQuantityWarnings,
    buildPortalAllocatedInventoryDeductions,
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

test("shipment closeout accepts shipment proof saved before the final status transaction", () => {
    assert.doesNotThrow(() => assertPortalShipmentProofRequirements(
        { documents: [] },
        {
            shipmentMethod: "LTL_FREIGHT",
            existingDocuments: [
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_BOL },
                { document_category: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_PACKING_SLIP },
                { documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_LOAD_PHOTO }
            ]
        }
    ));
});

test("warehouse UI saves shipment proof independently before final closeout", () => {
    const warehouseUi = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

    assert.match(warehouseUi, /async function uploadPortalShipmentProofInput\(input\)/);
    assert.match(warehouseUi, /requestJson\(`\/api\/admin\/portal-orders\/\$\{orderId\}\/documents`/);
    assert.match(warehouseUi, /Wait for each shipment document to show as saved before marking shipped/);
    assert.match(warehouseUi, /const documents = \[\];/);
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

test("missing freight proof override requires a super admin and an explicit reason", () => {
    const confirmation = {
        documents: [],
        missingShipmentProofOverride: true,
        missingShipmentProofOverrideReason: "Owner approved exception."
    };
    assert.throws(
        () => assertPortalShipmentProofRequirements(confirmation, {
            shipmentMethod: "LTL_FREIGHT",
            appUser: { role: APP_USER_ROLES.ADMIN }
        }),
        /super admin/i
    );
    assert.doesNotThrow(() => assertPortalShipmentProofRequirements(confirmation, {
        shipmentMethod: "LTL_FREIGHT",
        appUser: { role: APP_USER_ROLES.SUPER_ADMIN }
    }));
});

test("shipment proof override payload aliases are sanitized", () => {
    const confirmation = sanitizePortalShippingConfirmationInput({
        missing_shipment_proof_override: "yes",
        missing_shipment_proof_override_reason: "Owner approved exception."
    });
    assert.equal(confirmation.missingShipmentProofOverride, true);
    assert.equal(confirmation.missingShipmentProofOverrideReason, "Owner approved exception.");
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

test("warehouse shipment UI preserves editable shipped quantities and short-shipment warnings", () => {
    const warehouseUi = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

    assert.match(warehouseUi, /<th>Qty Shipped<\/th>/);
    assert.match(warehouseUi, /data-portal-ship-line-qty="\$\{attr\(order\.id\)\}"/);
    assert.match(warehouseUi, /shippedQuantity: Number\(input\.value\)/);
    assert.match(warehouseUi, /Shipped quantity is less than ordered:/);
    assert.match(warehouseUi, /Inventory will be deducted using the shipped quantities entered/);
    assert.match(warehouseUi, /shipmentQuantityWarnings/);
});

test("shipping confirmations use the warehouse overlay and cancellation stops closeout", () => {
    const warehouseUi = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const flow = warehouseUi.slice(warehouseUi.indexOf('title: "Short shipment"') - 100);
    const closeout = flow.slice(0, flow.indexOf('status: "SHIPPED"'));

    assert.match(closeout, /await confirmWarehouseAction\(\{\s+title: "Short shipment"/);
    assert.match(closeout, /if \(!confirmed\) \{[^}]*return;/);
    assert.match(closeout, /await confirmWarehouseAction\(\{\s+title: "Investigation Hold"/);
    assert.match(closeout, /if \(!packingSlipQuantityConfirmed\) \{[^}]*return;/);
    assert.doesNotMatch(closeout, /window\.confirm\(/);
});

test("Escape dismisses the visible warehouse error before closing the sales order", () => {
    const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const start = source.indexOf('if (event.key === "Escape" && ui.warehouseViewportAlert');
    const end = source.indexOf('if (event.key === "Escape" && document.body.classList.contains("purchase-order-popout-open"))', start);
    assert.ok(start >= 0 && end > start);
    const handle = vm.runInNewContext(`(ui, event, dismissWarehouseViewportAlert, closeSalesOrderDocument, isWarehouseSalesOrderDocumentOpen) => { ${source.slice(start, end)} }`);
    const hidden = { classList: { contains: () => true } };
    const alert = { hidden: false };
    const ui = { warehouseViewportAlert: alert, companySwitcherAddPopout: hidden,
        dashboardListPopout: hidden, feedbackModal: hidden, warehouseDocumentPreviewModal: hidden };
    const calls = [];
    const press = (key) => handle(ui, { key, preventDefault: () => calls.push("prevent") },
        () => { alert.hidden = true; calls.push("dismiss"); }, () => calls.push("close"), () => true);
    press("Enter");
    assert.deepEqual(calls, []);
    press("Escape");
    assert.deepEqual(calls, ["prevent", "dismiss"]);
    press("Escape");
    assert.deepEqual(calls, ["prevent", "dismiss", "close"]);
});

test("shipment inventory deductions combine duplicate allocations on one inventory line", () => {
    const order = {
        id: "101",
        lines: [
            { id: "11", sku: "SKU-A", quantity: 3 },
            { id: "12", sku: "SKU-B", quantity: 1 }
        ]
    };
    const shipmentLines = [
        { orderLineId: "11", sku: "SKU-A", shippedQuantity: 3 },
        { orderLineId: "12", sku: "SKU-B", shippedQuantity: 1 }
    ];
    const allocations = [
        { id: "1", order_line_id: "11", inventory_line_id: "500", sku: "SKU-A", allocated_quantity: 1 },
        { id: "2", order_line_id: "11", inventory_line_id: "500", sku: "SKU-A", allocated_quantity: 1 },
        { id: "3", order_line_id: "11", inventory_line_id: "500", sku: "SKU-A", allocated_quantity: 1 },
        { id: "4", order_line_id: "12", inventory_line_id: "600", sku: "SKU-B", allocated_quantity: 1 }
    ];

    const result = buildPortalAllocatedInventoryDeductions(order, shipmentLines, allocations);

    assert.deepEqual(result.deductions.map((entry) => ({
        inventoryLineId: entry.inventoryLineId,
        sku: entry.allocation.sku,
        requiredQuantity: entry.requiredQuantity
    })), [
        { inventoryLineId: "500", sku: "SKU-A", requiredQuantity: 3 },
        { inventoryLineId: "600", sku: "SKU-B", requiredQuantity: 1 }
    ]);
    assert.deepEqual([...result.remainingByLineId.entries()], [["11", 0], ["12", 0]]);
});

test("shipment inventory deductions preserve short-shipped allocation remainder", () => {
    const order = { id: "101", lines: [{ id: "11", sku: "SKU-A", quantity: 3 }] };
    const result = buildPortalAllocatedInventoryDeductions(order, [
        { orderLineId: "11", sku: "SKU-A", shippedQuantity: 2 }
    ], [
        { id: "1", order_line_id: "11", inventory_line_id: "500", sku: "SKU-A", allocated_quantity: 1 },
        { id: "2", order_line_id: "11", inventory_line_id: "500", sku: "SKU-A", allocated_quantity: 1 },
        { id: "3", order_line_id: "11", inventory_line_id: "500", sku: "SKU-A", allocated_quantity: 1 }
    ]);

    assert.equal(result.deductions.length, 1);
    assert.equal(result.deductions[0].requiredQuantity, 2);
    assert.equal(result.remainingByLineId.get("11"), 0);
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

test("carrier tracking URLs are generated for recognized parcel and freight carriers", () => {
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
    assert.equal(
        buildCarrierTrackingUrl("CanadaPost", "1234567890123456"),
        "https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=1234567890123456"
    );
    assert.equal(
        buildCarrierTrackingUrl("DHL Express", "JD014600006018545819"),
        "https://www.dhl.com/us-en/home/tracking.html?tracking-id=JD014600006018545819"
    );
    assert.equal(
        buildCarrierTrackingUrl("USPS", "9400111206212345678901"),
        "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111206212345678901"
    );
    assert.equal(
        buildCarrierTrackingUrl("Loomis Express", "123456789"),
        "https://www.loomisexpress.com/loomship/Track/Track.aspx?PieceNumber=123456789"
    );
    assert.equal(
        buildCarrierTrackingUrl("GLS Canada", "GLS123456789"),
        "https://ship.gls-canada.com/tracking/GLS123456789"
    );
    assert.equal(
        buildCarrierTrackingUrl("TForce Freight", "123456789"),
        "https://www.tforcefreight.com/ltl/apps/Tracking?proNumbers=123456789"
    );
    assert.equal(
        buildCarrierTrackingUrl("XPO Freight", "987654321"),
        "https://app.ltl.xpo.com/appjs/tracking/#/search/shipments?referenceNumber=987654321"
    );
    assert.equal(
        buildCarrierTrackingUrl("Old Dominion Freight Line", "1122334455"),
        "https://www.odfl.com/us/en/tools/trace-track-ltl-freight/trace-track.html?pro=1122334455"
    );
    assert.equal(
        buildCarrierTrackingUrl("Estes Express", "11223344"),
        "https://www.estes-express.com/myestes/shipment-tracking/?type=PRO&query=11223344"
    );
    assert.equal(
        buildCarrierTrackingUrl("R+L Carriers", "44556677"),
        "https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro=44556677"
    );
    assert.equal(
        buildCarrierTrackingUrl("ArcBest", "77889900"),
        "https://arcb.com/tools/tracking.html?pro=77889900"
    );
    assert.equal(
        buildCarrierTrackingUrl("Saia LTL", "55443322"),
        "https://www.saia.com/track/details;pro=55443322"
    );
    assert.equal(buildCarrierTrackingUrl("Unknown Freight", "123456789"), "");
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
