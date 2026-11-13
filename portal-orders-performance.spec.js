const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("sales-order queue loads independent related records concurrently", () => {
    const start = source.indexOf("async function getPortalOrderList(");
    const end = source.indexOf("async function getPortalOrderListForAccount", start);
    assert.ok(start >= 0 && end > start);
    const section = source.slice(start, end);
    assert.match(section, /Promise\.all\(\[\s*orderIds\.length/);
    assert.match(section, /getPortalShipmentLinesForOrders\(client, orderIds\)/);
    assert.match(section, /getPortalOrderPrintSummariesForOrders\(client, orderIds\)/);
    assert.match(section, /attachPortalInventoryPoolFlagsToOrders/);
    assert.match(section, /attachActiveTemporaryOversellPoliciesToOrderLines/);
});

test("sales-order queue exposes server timing without changing its JSON contract", () => {
    const start = source.indexOf('app.get("/api/admin/portal-orders"');
    const end = source.indexOf('app.get("/api/admin/shipment-email-alerts"', start);
    assert.ok(start >= 0 && end > start);
    const section = source.slice(start, end);
    assert.match(section, /process\.hrtime\.bigint\(\)/);
    assert.match(section, /Server-Timing/);
    assert.match(section, /X-WMS365-Result-Count/);
    assert.match(section, /res\.json\(\{ orders: visibleOrders \}\)/);
});
