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

test("sales-order detail overlaps independent reads without weakening tenant scope", () => {
    const start = source.indexOf("async function getPortalOrderById(");
    const end = source.indexOf("const ADDRESS_COUNTRY_CODES", start);
    assert.ok(start >= 0 && end > start);
    const section = source.slice(start, end);

    assert.match(section, /where o\.id = \$1\s+and o\.account_name = \$2/);
    assert.match(section, /where l\.order_id = \$1\s+and o\.account_name = \$2/);
    assert.match(section, /exists \(\s*select 1\s*from company_fulfillment_locations source_cfl/);
    assert.doesNotMatch(section, /attachPortalInventoryPoolFlagsToOrders/);
    assert.match(section, /Promise\.all\(\[\s*client\.query\(/);
    assert.match(section, /getPortalShipmentLinesForOrders\(client, \[orderId\]\)/);
    assert.match(section, /getPortalOrderPrintSummariesForOrders\(client, \[orderId\]\)/);
    assert.match(section, /getShipmentTrackingForOrder\(client, orderId, normalizedAccount\)/);
});

test("sales-order detail keeps policy-dependent allocation reads after line policy enrichment", () => {
    const start = source.indexOf("async function getPortalOrderById(");
    const end = source.indexOf("const ADDRESS_COUNTRY_CODES", start);
    const section = source.slice(start, end);
    const policyIndex = section.indexOf("await attachActiveTemporaryOversellPoliciesToOrderLines");
    const allocationIndex = section.indexOf("buildPortalOrderAllocationSummaries");
    const locationIndex = section.indexOf("buildPortalOrderLocationSummaries");

    assert.ok(policyIndex >= 0);
    assert.ok(allocationIndex > policyIndex);
    assert.ok(locationIndex > policyIndex);
    assert.match(
        section.slice(policyIndex),
        /Promise\.all\(\[\s*buildPortalOrderAllocationSummaries[\s\S]*buildPortalOrderLocationSummaries/
    );
    assert.match(section, /scopePortalOrderToFulfillmentLocationIds|warehouseShipments/);
});
