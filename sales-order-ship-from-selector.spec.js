const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("company workspace exposes one active warehouse selector on desktop and mobile", () => {
    assert.match(desktop, /id="activeWarehouse"[^>]*aria-label="Active warehouse"/);
    assert.match(desktop, /id="mobileActiveWarehouse"/);
    assert.match(desktop, /function getAuthorizedCompanyWarehouseAssignments[\s\S]*?assignedFulfillmentLocations/);
    assert.match(desktop, /function setActiveWarehouse[\s\S]*?refreshCompanyScopedUi/);
    assert.doesNotMatch(desktop, /id="warehouseOrderFulfillmentLocation"/);
});

test("sales and purchase orders inherit the workspace warehouse with direction checks", () => {
    assert.match(desktop, /warehouseSalesOrderFulfillmentLocationId = order\?\.fulfillmentLocationId \|\| getActiveWarehouseAssignment/);
    assert.match(desktop, /fulfillmentLocationId: warehouseSalesOrderFulfillmentLocationId \|\| getActiveWarehouseAssignment/);
    assert.match(desktop, /getCompanyOutboundFulfillmentAssignments\(payload\.accountName\)[\s\S]*?active warehouse is not assigned to this company for outbound orders/);
    assert.match(desktop, /warehouseInboundFulfillmentLocationId = inbound\?\.fulfillmentLocationId \|\| getActiveWarehouseAssignment/);
    assert.match(desktop, /inboundWarehouseIds[\s\S]*?assignment\.allowInbound !== false[\s\S]*?active warehouse is not assigned to this company for inbound orders/);
});

test("warehouse selection scopes order and inbound requests, cache keys, and stale responses", () => {
    assert.match(desktop, /getPortalOrdersRequestKey[\s\S]*?ALL_WAREHOUSES/);
    assert.match(desktop, /params\.set\("fulfillmentLocationId", locationId\)/);
    assert.match(desktop, /isPortalOrdersRefreshCurrent[\s\S]*?getActiveWarehouseAssignment/);
    assert.match(desktop, /requestPortalInboundsForCompany[\s\S]*?ALL_WAREHOUSES/);
    assert.match(desktop, /isPortalInboundsRefreshCurrent[\s\S]*?getActiveWarehouseAssignment/);
});

test("server authorizes and filters explicit warehouse scopes", () => {
    assert.match(server, /app\.get\("\/api\/admin\/portal-orders"[\s\S]*?requestedLocationId[\s\S]*?assertAppUserFulfillmentLocationAccess[\s\S]*?locationScopedOrders/);
    assert.match(server, /app\.get\("\/api\/admin\/portal-inbounds"[\s\S]*?requestedLocationId[\s\S]*?assertAppUserFulfillmentLocationAccess[\s\S]*?visibleInbounds/);
    assert.match(server, /saveWarehousePortalInbound[\s\S]*?direction: "INBOUND"[\s\S]*?assertAppUserFulfillmentLocationAccess/);
});

test("sales-order close and new actions protect unsaved fields and lines", () => {
    assert.match(desktop, /let warehouseSalesOrderFormBaseline = ""/);
    assert.match(desktop, /function serializeWarehouseSalesOrderForm[\s\S]*?JSON\.stringify\(collectWarehouseSalesOrderPayload\(\)\)/);
    assert.match(desktop, /function confirmDiscardWarehouseSalesOrderChanges[\s\S]*?Discard the unsaved changes to this sales order/);
});
