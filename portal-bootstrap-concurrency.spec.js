const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const portalSource = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const loadStart = portalSource.indexOf("async function loadPortalData()");
const loadEnd = portalSource.indexOf("\n        function applyOrderStatusFilter", loadStart);
const loadPortalDataSource = portalSource.slice(loadStart, loadEnd);

test("customer portal starts warehouse-independent reads before location discovery completes", () => {
    assert.ok(loadStart >= 0 && loadEnd > loadStart, "loadPortalData must remain inspectable");

    const fulfillmentStart = loadPortalDataSource.indexOf("const fulfillmentRequest =");
    const independentStart = loadPortalDataSource.indexOf("const independentRequests = [");
    const fulfillmentAwait = loadPortalDataSource.indexOf("const fulfillmentPayload = await fulfillmentRequest;");

    assert.ok(fulfillmentStart >= 0, "fulfillment discovery should start as a promise");
    assert.ok(independentStart > fulfillmentStart, "independent reads should start after discovery is launched");
    assert.ok(fulfillmentAwait > independentStart, "location discovery must not serialize independent portal reads");
    assert.doesNotMatch(
        loadPortalDataSource.slice(fulfillmentStart, independentStart),
        /await\s+requestJson\("\/api\/portal\/fulfillment-locations"\)/,
        "fulfillment discovery must not be awaited before independent reads start"
    );

    for (const route of [
        "/api/portal/items",
        "/api/portal/kitting-requests",
        "/api/portal/invoices",
        "/api/portal/orders",
        "/api/portal/inbounds",
        "/api/portal/delivery-appointments",
        "/api/portal/ship-to-addresses",
        "/api/portal/jobs"
    ]) {
        assert.ok(
            loadPortalDataSource.slice(independentStart, fulfillmentAwait).includes(`requestJson("${route}`),
            `${route} should be started before location discovery completes`
        );
    }
});

test("warehouse inventory still waits for the authorized location and permission gate", () => {
    const fulfillmentAwait = loadPortalDataSource.indexOf("const fulfillmentPayload = await fulfillmentRequest;");
    const warehouseRender = loadPortalDataSource.indexOf("renderPortalWarehouseSwitcher();");
    const inventoryStart = loadPortalDataSource.indexOf("requestJson(portalWarehouseScopedUrl(\"/api/portal/inventory\"))");

    assert.ok(warehouseRender > fulfillmentAwait, "warehouse state should be applied after location discovery");
    assert.ok(inventoryStart > warehouseRender, "inventory must wait for the scoped warehouse selection");
    assert.match(
        loadPortalDataSource.slice(warehouseRender, inventoryStart),
        /canInventory\s*&&\s*portalState\.activeFulfillmentLocationId/,
        "inventory must retain both its permission and selected-location gates"
    );
    assert.match(loadPortalDataSource, /\.\.\.independentRequests/);
});
