const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const start = source.indexOf("function pdfBolSectionBar(");
const end = source.indexOf("function buildPortalOrderBillOfLadingPdfAttachment(", start);
assert.ok(start >= 0 && end > start, "BOL layout source must be present");

const context = {
    pdfText: (value) => String(value),
    pdfRect: () => "",
    pdfStrokeRect: () => "",
    pdfLine: () => "",
    pdfSafeText: (value) => String(value || ""),
    drawCode128BarcodeOps: () => [],
    encodeCode128BValues: () => [],
    getFulfillmentLocationDisplayName: () => "Test Warehouse",
    shipmentMethodLabel: () => "LTL freight",
    bolDateLabel: () => "09/23/2026",
    bolWeightLabel: () => "100.0 LB",
    wrapPdfText: (value) => [value]
};
vm.runInNewContext(`${source.slice(start, end)}\nthis.render = buildPortalOrderBillOfLadingPage;`, context);
const ops = context.render({
    accountName: "CODEX PORTAL SYSTEM TEST",
    orderCode: "TEST-BOL",
    poNumber: "TEST-PO",
    shipToName: "Test Receiver",
    shipToAddress1: "Test Address",
    shipToCity: "Test City",
    shipToState: "ON",
    shipToPostalCode: "L5T 1V6",
    shipToCountry: "Canada"
}, {
    warehouse: {},
    bolReference: "TEST-BOL",
    carrier: "Test Carrier",
    method: "LTL_FREIGHT",
    deliveryDate: "2026-09-23",
    trackingReference: "TEST-PRO",
    totalPallets: 1,
    totalWeight: 100,
    weightUom: "LB"
}, [{ handlingUnits: 1, packageType: "PALLET", sku: "TEST-SKU", description: "Test freight", weight: 100 }]);
const content = ops.join("\n");
for (const label of [
    "FREIGHT CHARGE TERMS - SELECT ONE BEFORE TENDER",
    "PREPAID",
    "COLLECT",
    "THIRD PARTY",
    "Third-party freight charges bill to",
    "SHIPPER",
    "CARRIER / DRIVER",
    "RECEIVER / PROOF OF DELIVERY",
    "Signature:"
]) assert.ok(content.includes(label), `Missing BOL field: ${label}`);
console.log("BOL freight-terms and receipt fields verified in isolated renderer.");
