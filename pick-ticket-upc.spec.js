const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const server = fs.readFileSync("server.js", "utf8");
const desktop = fs.readFileSync("index.html", "utf8");

test("pick-ticket formats preserve their established UPC presentation", () => {
    const pdfTicket = server.split("function buildPortalOrderPickTicketLines(")[1]
        .split("function buildPortalOrderPickTicketPdfAttachment(")[0];
    const browserTicket = desktop.split("function buildPickTicketHtml(")[1]
        .split("function buildPackingSlipHtml(")[0];
    assert.match(server, /c\.upc as item_upc/);
    assert.match(server, /upc: row\.item_upc \|\| ""/);
    assert.match(pdfTicket, /line\.upc \? `UPC \$\{line\.upc\}` : ""/);
    assert.match(browserTicket, /<th>SKU<\/th><th>UPC<\/th>/);
    assert.match(browserTicket, /<td>\$\{esc\(String\(line\.upc \|\| ""\)\.trim\(\)\.replace\(/);
    assert.match(browserTicket, /"Not recorded"/);
});

test("rendered browser pick ticket shows both recorded and missing UPCs", () => {
    const source = "function buildPickTicketHtml(" + desktop.split("function buildPickTicketHtml(")[1]
        .split("function buildBatchPickTicketHtml(")[0];
    const render = vm.runInNewContext(`(${source})`, {
        buildCode39Svg: () => "", formatPortalOrderShipFrom: () => "",
        formatPortalOrderShipTo: () => "", formatTrackedQuantity: (quantity) => String(quantity),
        formatPickLocationHtml: () => "", esc: (value) => String(value)
    });
    const html = render({ orderCode: "ORD-TEST", accountName: "TEST CUSTOMER", status: "RELEASED",
        lines: [
            { sku: "SKU-A", upc: "19421905946343.0", quantity: 1 },
            { sku: "SKU-B", upc: "", quantity: 2 }
        ] });
    assert.match(html, /<th>UPC<\/th>/);
    assert.match(html, /<td>19421905946343<\/td>/);
    assert.doesNotMatch(html, /19421905946343\.0/);
    assert.match(html, /<td>Not recorded<\/td>/);
});

test("bulk browser pick tickets reuse the canonical single-order layout one order per page", () => {
    const batchSource = "function buildBatchPickTicketHtml(" + desktop.split("function buildBatchPickTicketHtml(")[1]
        .split("function buildPackingSlipHtml(")[0];
    const render = vm.runInNewContext(`(${batchSource})`, {
        buildPickTicketHtml: (order) => `<!doctype html><html><head><style>body{font-family:Arial}.box{border:1px solid #ccc}</style></head><body><h1>Pick Ticket</h1><div class="box">${order.orderCode}</div></body></html>`
    });
    const html = render([{ orderCode: "ORD-A" }, { orderCode: "ORD-B" }]);
    assert.match(html, /body\{font-family:Arial\}/);
    assert.match(html, /@page\{size:letter;margin:0\}/);
    assert.equal((html.match(/class="batch-pick-ticket"/g) || []).length, 2);
    assert.match(html, /ORD-A/);
    assert.match(html, /ORD-B/);
    assert.doesNotMatch(html, /buildSimpleTextPdf/);
});

test("bulk print loads current order details and does not use the legacy text PDF endpoint", () => {
    const handler = desktop.split("async function printSelectedPortalOrderPickTickets(")[1]
        .split("async function onPortalOrdersListClick(")[0];
    assert.match(handler, /await requestPortalOrderDetail\(orderId\)/);
    assert.match(handler, /buildBatchPickTicketHtml\(orders\)/);
    assert.match(handler, /recordPortalOrderPrintEvent\(order, "pick"\)/);
    assert.doesNotMatch(handler, /batch-pick-tickets\.pdf/);
});

test("rendered PDF pick-ticket lines preserve the original inline description and UPC layout", () => {
    const source = "function buildPortalOrderPickTicketLines(" + server.split("function buildPortalOrderPickTicketLines(")[1]
        .split("function buildPortalOrderPickTicketPdfAttachment(")[0];
    const render = vm.runInNewContext(`(${source})`, {
        getPortalOrderDocumentFulfillmentGroups: () => [], normalizePortalOrderStatus: (value) => value,
        formatPickTicketWorkflowStatus: (order) => order.status,
        buildPortalOrderProcessingTiming: () => ({}), buildPortalOrderEditReadyDateWarning: () => "",
        wrapPdfText: (value) => [value], formatPortalOrderShipToAddress: () => "",
        normalizeText: (value) => value || "", pdfSafeText: (value) => value,
        formatTrackedQuantity: (quantity) => String(quantity), formatPickTicketLocationText: () => "BULK"
    });
    const lines = render({ orderCode: "ORD-TEST", accountName: "TEST CUSTOMER", status: "DRAFT",
        lines: [
            { sku: "SKU-A", description: "Item A", upc: "19421905946343.0", quantity: 1 },
            { sku: "SKU-B", description: "Item B", upc: "", quantity: 2 }
        ] });
    assert.ok(lines.includes("    Item A | UPC 19421905946343.0"));
    assert.ok(lines.includes("    Item B"));
    assert.equal(lines.some((line) => /Not recorded/.test(line)), false);
    assert.equal(lines.some((line) => /^\s+UPC:/.test(line)), false);
});

test("PDF pick ticket gives Ship To a clear section break and wraps long address lines", () => {
    const source = "function buildPortalOrderPickTicketLines(" + server.split("function buildPortalOrderPickTicketLines(")[1]
        .split("function buildPortalOrderPickTicketPdfAttachment(")[0];
    const render = vm.runInNewContext(`(${source})`, {
        getPortalOrderDocumentFulfillmentGroups: () => [], normalizePortalOrderStatus: (value) => value,
        formatPickTicketWorkflowStatus: (order) => order.status,
        buildPortalOrderProcessingTiming: () => ({}), buildPortalOrderEditReadyDateWarning: () => "",
        wrapPdfText: (value, width) => String(value).length > width
            ? [String(value).slice(0, width), String(value).slice(width)] : [String(value)],
        formatPortalOrderShipToAddress: () => `Recipient Name | ${"A".repeat(90)} | Toronto, ON, M1A 1A1 | Canada`,
        normalizeText: (value) => value || "", pdfSafeText: (value) => value,
        formatTrackedQuantity: (quantity) => String(quantity), formatPickTicketLocationText: () => "BULK"
    });
    const lines = render({ orderCode: "ORD-TEST", accountName: "TEST CUSTOMER", status: "DRAFT",
        contactName: "Warehouse Contact", contactPhone: "555-0100",
        lines: [{ sku: "SKU-A", description: "Item A", quantity: 1 }] });
    const contactIndex = lines.indexOf("Customer Contact: Warehouse Contact | 555-0100");
    const shipToIndex = lines.indexOf("Ship To:");
    assert.equal(lines[contactIndex + 1], "");
    assert.equal(shipToIndex, contactIndex + 2);
    assert.deepEqual(Array.from(lines.slice(shipToIndex + 1, shipToIndex + 7)), [
        "  Recipient Name", `  ${"A".repeat(84)}`, `  ${"A".repeat(6)}`,
        "  Toronto, ON, M1A 1A1", "  Canada", ""
    ]);
});

test("the order-editor print button reloads the current order before printing", () => {
    const handler = desktop.split("async function printCurrentWarehouseSalesOrderDocument(")[1]
        .split("function getSelectedBatchPickTicketOrderIds(")[0];
    assert.match(handler, /await requestPortalOrderDetail\(order\.id\)/);
    assert.match(handler, /await printPortalOrderDocument\(currentOrder,/);
    assert.match(handler, /\["DRAFT", "CANCELLED", "ARCHIVED"\]\.includes\(currentOrder\.status\)/);
});

test("the order-editor print action passes fresh order details to the pick-ticket view", async () => {
    const source = "async function printCurrentWarehouseSalesOrderDocument(" + desktop
        .split("async function printCurrentWarehouseSalesOrderDocument(")[1]
        .split("function getSelectedBatchPickTicketOrderIds(")[0];
    const calls = [];
    const current = { id: "1075", status: "RELEASED", lines: [{ sku: "S164", upc: "19421905946343.0" }] };
    const print = vm.runInNewContext(`(${source})`, {
        editingWarehouseOrderId: "1075",
        getPortalOrderById: () => ({ id: "1075", status: "RELEASED", lines: [] }),
        requestPortalOrderDetail: async (id) => { calls.push(["fetch", id]); return current; },
        printPortalOrderDocument: async (order, type) => { calls.push(["print", order, type]); },
        showMessage: () => { throw new Error("Unexpected print error"); },
        ui: { warehouseOrderMessage: {} }
    });
    await print("pick");
    assert.equal(calls[0][0], "fetch");
    assert.equal(calls[0][1], "1075");
    assert.equal(calls[1][0], "print");
    assert.equal(calls[1][1], current);
    assert.equal(calls[1][2], "pick");
});
