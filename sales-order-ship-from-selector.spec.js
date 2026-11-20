const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("sales order form exposes an explicit company-scoped ship-from selector", () => {
    assert.match(desktop, /id="warehouseOrderFulfillmentLocation"[^>]*required/);
    assert.match(desktop, /warehouseOrderFulfillmentLocation: document\.getElementById\("warehouseOrderFulfillmentLocation"\)/);
    assert.match(desktop, /function getCompanyOutboundFulfillmentAssignments[\s\S]*?allowOutbound === false[\s\S]*?fulfillmentLocationId/);
    assert.match(desktop, /function refreshWarehouseOrderFulfillmentSelector[\s\S]*?assignment\.isPrimary/);
});

test("sales order payload sends the selected warehouse and blocks missing or stale scope", () => {
    assert.match(desktop, /fulfillmentLocationId: ui\.warehouseOrderFulfillmentLocation\.value/);
    assert.match(desktop, /if \(!payload\.fulfillmentLocationId\)[\s\S]*?Choose the ship-from warehouse for this transaction/);
    assert.match(desktop, /allowedWarehouseIds[\s\S]*?getCompanyOutboundFulfillmentAssignments\(payload\.accountName\)/);
    assert.match(desktop, /not assigned to the active company for outbound orders/);
});

test("opening and duplicating an order preserve its warehouse while a new order uses the primary assignment", () => {
    assert.match(desktop, /refreshWarehouseOrderFulfillmentSelector\(order\?\.fulfillmentLocationId \|\| ""\)/);
    assert.match(desktop, /const selectedAssignment = assignments\.find[\s\S]*?assignment\.isPrimary[\s\S]*?assignments\.length === 1/);
});

test("sales-order close and new actions protect unsaved fields and lines", () => {
    assert.match(desktop, /let warehouseSalesOrderFormBaseline = ""/);
    assert.match(desktop, /function serializeWarehouseSalesOrderForm[\s\S]*?JSON\.stringify\(collectWarehouseSalesOrderPayload\(\)\)/);
    assert.match(desktop, /function hasUnsavedWarehouseSalesOrderChanges[\s\S]*?serializeWarehouseSalesOrderForm\(\) !== warehouseSalesOrderFormBaseline/);
    assert.match(desktop, /function confirmDiscardWarehouseSalesOrderChanges[\s\S]*?Discard the unsaved changes to this sales order/);
    assert.match(desktop, /function closeSalesOrderDocument[\s\S]*?if \(!confirmDiscardWarehouseSalesOrderChanges\(\)\) return false/);
    assert.match(desktop, /function openNewSalesOrderDocument[\s\S]*?if \(!confirmDiscardWarehouseSalesOrderChanges\(\)\) return false/);
});
