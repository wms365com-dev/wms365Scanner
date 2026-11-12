const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("sales orders expose duplicate and shipped-order return actions", () => {
    assert.match(server, /app\.post\("\/api\/admin\/portal-orders\/:id\/duplicate"/);
    assert.match(server, /app\.post\("\/api\/admin\/portal-orders\/:id\/return-inbound"/);
    assert.match(desktop, /id="salesOrderCommandDuplicateBtn"/);
    assert.match(desktop, /id="salesOrderCommandReturnBtn"/);
    assert.match(desktop, /id="duplicateWarehouseOrderBtn"/);
    assert.match(desktop, /id="createWarehouseReturnBtn"/);
    assert.match(desktop, /async function duplicateWarehouseSalesOrder/);
    assert.match(desktop, /async function createWarehouseSalesOrderReturnInbound/);
});

test("duplicate and return actions remain visible in the mobile order action row", () => {
    assert.match(desktop, /\[ui\.salesOrderCommandDuplicateBtn, ui\.duplicateWarehouseOrderBtn\][\s\S]*?button\.hidden = !canDuplicateOrder/);
    assert.match(desktop, /\[ui\.salesOrderCommandReturnBtn, ui\.createWarehouseReturnBtn\][\s\S]*?button\.hidden = !canCreateReturn/);
    const resetStart = desktop.indexOf("function resetWarehouseSalesOrderForm");
    const saveStart = desktop.indexOf("async function saveWarehouseSalesOrderDraft", resetStart);
    const resetBody = desktop.slice(resetStart, saveStart);
    assert.match(resetBody, /const canDuplicateOrder/);
    assert.match(resetBody, /const canCreateReturn/);
});

test("duplicate order is a reviewable draft with an original-order R reference", () => {
    assert.match(server, /function appendReturnReference\(value\)[\s\S]*?return `\$\{base \|\| "ORDER"\}-R`/);
    assert.match(server, /async function duplicateWarehousePortalOrder[\s\S]*?orderCodeOverride: duplicateCode/);
    assert.match(server, /Duplicated warehouse draft requires review before release/);
    assert.match(server, /duplicated_from_order_id/);
    assert.match(server, /idx_portal_orders_duplicate_source/);
});

test("return inbound requires shipment completion and uses actual shipped quantities", () => {
    assert.match(server, /source\.status !== "SHIPPED"/);
    assert.match(server, /source\.shipmentLines\?\.length \? \(shippedByLineId\.get\(String\(line\.id\)\) \|\| 0\)/);
    assert.match(server, /inboundCodeOverride: returnCode/);
    assert.match(server, /Receive and inspect before putting stock into a pickable location/);
    assert.match(server, /return_from_order_id/);
    assert.match(server, /idx_portal_inbounds_return_source/);
});

test("return and duplicate actions are retry safe", () => {
    assert.match(server, /where duplicated_from_order_id = \$1 limit 1/);
    assert.match(server, /where return_from_order_id = \$1 limit 1/);
    assert.match(server, /alreadyExists: true/g);
});
