const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("printing updates print history without rebuilding unsaved sales-order fields", () => {
    const start = source.indexOf("async function recordPortalOrderPrintEvent");
    const end = source.indexOf("async function queuePortalOrderWarehousePrintJob", start);
    assert.ok(start >= 0 && end > start, "print event handler must exist");
    const handler = source.slice(start, end);
    assert.match(handler, /mergePortalOrderRecord/);
    assert.match(handler, /renderPortalOrdersList/);
    assert.doesNotMatch(handler, /resetWarehouseSalesOrderForm/);
});
