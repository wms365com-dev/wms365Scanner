const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    getPortalOrderBolShipmentEntries,
    getPortalOrderBillOfLadingReadiness,
    buildPortalOrderBillOfLadingPdfAttachment
} = require("./server.js");

function stagedFreightOrder(overrides = {}) {
    return {
        id: "9001",
        orderCode: "ORD-TEST-BOL-001",
        accountName: "WMS365 TEST COMPANY",
        status: "STAGED",
        poNumber: "PO-TEST-001",
        shippingReference: "TEST-BOL",
        requestedShipDate: "2026-09-03",
        shipmentMethod: "LTL_FREIGHT",
        shippedCarrierName: "Day & Ross",
        shippedTrackingReference: "PRO-TEST-100",
        shipToName: "Test Receiving",
        shipToAddress1: "100 Test Avenue",
        shipToCity: "Toronto",
        shipToState: "ON",
        shipToPostalCode: "M1M 1M1",
        shipToCountry: "Canada",
        fulfillmentLocationId: "101",
        fulfillmentLocationCode: "TEST-WH",
        fulfillmentLocationName: "WMS365 Test Warehouse",
        fulfillmentPartnerName: "WMS365 Test Warehouse",
        fulfillmentAddress1: "200 Warehouse Road",
        fulfillmentCity: "Mississauga",
        fulfillmentState: "ON",
        fulfillmentPostalCode: "L5T 1A1",
        fulfillmentCountry: "Canada",
        outboundPallets: { totalPalletsOut: 2 },
        routingTotalWeight: 1200,
        routingWeightUom: "LB",
        routingRequestedDeliveryDate: "2026-09-03",
        lines: [{
            id: "1",
            lineNumber: 1,
            sku: "TEST-SKU",
            description: "Test Product",
            quantity: 20,
            trackingLevel: "CASE",
            pickLocations: []
        }],
        warehouseShipments: [{
            id: "501",
            externalId: "SHP-ORD-TEST-BOL-001-101",
            status: "STAGED",
            warehouse: { id: "101", code: "TEST-WH", name: "WMS365 Test Warehouse" },
            shipmentMethod: "LTL_FREIGHT",
            carrier: "Day & Ross",
            trackingReference: "PRO-TEST-100",
            bolReference: "BOL-ORD-TEST-BOL-001",
            pallets: { total: 2 },
            totalWeight: 1200,
            weightUom: "LB",
            deliveryDate: "2026-09-03"
        }],
        ...overrides
    };
}

test("BOL readiness requires a staged order", () => {
    const readiness = getPortalOrderBillOfLadingReadiness(stagedFreightOrder({ status: "PICKED" }));
    assert.equal(readiness.ready, false);
    assert.match(readiness.missingFields.join(" | "), /status must be STAGED/i);
});

test("BOL readiness identifies missing carrier, pallet count, weight, and delivery date", () => {
    const order = stagedFreightOrder();
    order.warehouseShipments[0] = {
        ...order.warehouseShipments[0],
        carrier: "",
        pallets: { total: 0 },
        totalWeight: null,
        deliveryDate: ""
    };
    order.shippedCarrierName = "";
    order.outboundPallets = { totalPalletsOut: 0 };
    order.routingTotalWeight = null;
    order.routingRequestedDeliveryDate = "";
    order.requestedShipDate = "";
    const missing = getPortalOrderBillOfLadingReadiness(order).missingFields.join(" | ");
    assert.match(missing, /Carrier/);
    assert.match(missing, /Total pallets/);
    assert.match(missing, /Total shipment weight/);
    assert.match(missing, /Delivery or requested ship date/);
});

test("parcel shipments cannot generate a BOL", () => {
    const order = stagedFreightOrder({ shipmentMethod: "PARCEL" });
    order.warehouseShipments[0].shipmentMethod = "PARCEL";
    const readiness = getPortalOrderBillOfLadingReadiness(order);
    assert.equal(readiness.ready, false);
    assert.match(readiness.missingFields.join(" | "), /parcel shipments do not use a BOL/i);
});

test("valid staged freight order is ready and produces a branded PDF", () => {
    const order = stagedFreightOrder();
    const readiness = getPortalOrderBillOfLadingReadiness(order);
    assert.equal(readiness.ready, true);
    const attachment = buildPortalOrderBillOfLadingPdfAttachment(order);
    assert.equal(attachment.contentType, "application/pdf");
    assert.match(attachment.filename, /bill-of-lading\.pdf$/);
    assert.equal(attachment.content.subarray(0, 4).toString(), "%PDF");
    const pdfText = attachment.content.toString("utf8");
    assert.match(pdfText, /STRAIGHT BILL OF LADING/);
    assert.match(pdfText, /WMS365 \| wms365\.co/);
    assert.match(pdfText, /Day & Ross/);
    assert.match(pdfText, /ORD-TEST-BOL-001/);
});

test("split orders preserve separate warehouse shipment weights and BOL pages", () => {
    const order = stagedFreightOrder();
    order.lines = [
        {
            id: "1", lineNumber: 1, sku: "TEST-A", description: "Test A", quantity: 8, trackingLevel: "CASE",
            pickLocations: [{
                location: "A01", quantity: 8, fulfillmentLocationId: "101", fulfillmentLocationCode: "TEST-A",
                fulfillmentLocationName: "Test Warehouse A", fulfillmentAddress1: "1 Alpha Road",
                fulfillmentCity: "Toronto", fulfillmentState: "ON", fulfillmentPostalCode: "M1A 1A1", fulfillmentCountry: "Canada"
            }]
        },
        {
            id: "2", lineNumber: 2, sku: "TEST-B", description: "Test B", quantity: 12, trackingLevel: "CASE",
            pickLocations: [{
                location: "B01", quantity: 12, fulfillmentLocationId: "102", fulfillmentLocationCode: "TEST-B",
                fulfillmentLocationName: "Test Warehouse B", fulfillmentAddress1: "2 Beta Road",
                fulfillmentCity: "Mississauga", fulfillmentState: "ON", fulfillmentPostalCode: "L5B 2B2", fulfillmentCountry: "Canada"
            }]
        }
    ];
    order.warehouseShipments = [
        { ...order.warehouseShipments[0], id: "501", warehouse: { id: "101", code: "TEST-A", name: "Test Warehouse A" }, pallets: { total: 1 }, totalWeight: 500, bolReference: "BOL-A" },
        { ...order.warehouseShipments[0], id: "502", externalId: "SHP-B", warehouse: { id: "102", code: "TEST-B", name: "Test Warehouse B" }, pallets: { total: 2 }, totalWeight: 900, bolReference: "BOL-B" }
    ];
    const shipments = getPortalOrderBolShipmentEntries(order);
    assert.deepEqual(shipments.map((shipment) => shipment.totalWeight), [500, 900]);
    assert.deepEqual(shipments.map((shipment) => shipment.totalPallets), [1, 2]);
    const attachment = buildPortalOrderBillOfLadingPdfAttachment(order);
    assert.equal((attachment.content.toString("utf8").match(/STRAIGHT BILL OF LADING/g) || []).length, 2);
});

test("BOL routes and UI preserve warehouse access controls and staged-only visibility", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.match(server, /portal-orders\/:id\/bill-of-lading\/prepare[\s\S]*?assertAppUserCustomerWarehouseAccess/);
    assert.match(server, /portal-orders\/:id\/bill-of-lading\.pdf[\s\S]*?assertAppUserCustomerWarehouseAccess/);
    assert.match(server, /scopePortalOrderToFulfillmentLocationIds[\s\S]*?buildPortalOrderBillOfLadingPdfAttachment/);
    assert.match(html, /id="salesOrderCommandBolBtn"[^>]*hidden/);
    assert.match(html, /order\.status === "STAGED"[^\n]*data-generate-bol/);
    assert.match(html, /id="orderBolModal"/);
    assert.match(html, /bill-of-lading\/prepare/);
    assert.match(
        html,
        /#orderRoutingDraftModal,\s*#orderBolModal\s*\{\s*z-index:\s*4100;/,
        "BOL and routing dialogs must render above the desktop sales-order window"
    );
});
