const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const server = fs.readFileSync("server.js", "utf8");
const desktop = fs.readFileSync("index.html", "utf8");

test("server-generated pick tickets and packing slips include the order barcode", () => {
    assert.match(server, /buildSimpleTextPdfBuffer\(lines, \{ barcodeText: order\.orderCode \|\| "" \}\)/);
    assert.match(server, /encodeCode128BValues/);
    assert.match(server, /drawCode128BarcodeOps\(barcodeValues/);
});

test("server-generated pick-ticket notices wrap within the printable page", () => {
    const wrappedNotices = server.match(/\.\.\.wrapPdfText\(buildPortalOrderEditReadyDateWarning\(\), 88\)/g) || [];
    assert.ok(wrappedNotices.length >= 2);
});

test("browser-printed pick tickets and packing slips show a top-right order barcode", () => {
    assert.match(desktop, /class="document-header"><h1>Pick Ticket<\/h1><div class="order-barcode">/);
    assert.match(desktop, /class="document-header"><h1>Packing Slip<\/h1><div class="order-barcode">/);
    assert.match(desktop, /buildCode39Svg\(order\.orderCode/);
});

test("an exact barcode scan opens its order from the sales-order search", () => {
    assert.match(desktop, /Search or Scan Orders/);
    assert.match(desktop, /norm\(order\.orderCode\) === scannedOrderCode/);
    assert.match(desktop, /await openSalesOrderDetail\(exactOrder\.id/);
});
