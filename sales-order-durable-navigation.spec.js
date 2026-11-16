"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("sales orders use validated, history-aware durable URLs", () => {
    assert.match(warehouse, /function getSalesOrderIdFromUrl\(\)/);
    assert.match(warehouse, /params\.get\("salesOrderId"\)/);
    assert.match(warehouse, /\/\^\[1-9\]\\d\*\$\/\.test\(orderId\)/);
    assert.match(warehouse, /url\.searchParams\.set\("salesOrderId", normalizedOrderId\)/);
    assert.match(warehouse, /window\.history\[replace \? "replaceState" : "pushState"\]/);
    assert.match(warehouse, /try \{[\s\S]*?window\.history\[replace \? "replaceState" : "pushState"\][\s\S]*?\} catch \(error\) \{[\s\S]*?continuing with the current page/);
    assert.match(warehouse, /window\.addEventListener\("popstate"/);
    assert.match(warehouse, /applySalesOrderRouteFromUrl\(\{ fromHistory: true \}\)/);
});

test("opening a listed order uses a loading shell before fetching current detail", () => {
    assert.match(warehouse, /const summary = getPortalOrderById\(orderId\);[\s\S]*?if \(summary\) \{[\s\S]*?showSalesOrderLoadingDocument\(summary/);
    assert.doesNotMatch(warehouse, /if \(summary\) \{[\s\S]{0,160}?showSalesOrderDocument\(summary/);
    assert.match(warehouse, /function showSalesOrderLoadingDocument\([\s\S]*?warehouseOrderForm\?\.classList\.add\("hidden"\)[\s\S]*?warehouseOrderWorkflowPanel\?\.classList\.add\("hidden"\)/);
    assert.doesNotMatch(warehouse, /function showSalesOrderLoadingDocument\([\s\S]*?resetWarehouseSalesOrderForm\(summary\)/);
    assert.match(warehouse, /function showSalesOrderDocument\([\s\S]*?removeAttribute\("aria-busy"\)[\s\S]*?warehouseOrderForm\?\.classList\.remove\("hidden"\)[\s\S]*?resetWarehouseSalesOrderForm\(order\)/);
    assert.match(warehouse, /requestJson\(`\/api\/admin\/portal-orders\/\$\{encodeURIComponent\(key\)\}`\)/);
    assert.match(warehouse, /const requestSerial = \+\+salesOrderOpenRequestSerial/);
    assert.match(warehouse, /if \(requestSerial !== salesOrderOpenRequestSerial\) \{[\s\S]*?return null/);
    assert.doesNotMatch(warehouse, /localStorage[^\n]*(?:portalOrder|salesOrder)/i);
});

test("history failures cannot prevent a permission-scoped detail request", () => {
    const openStart = warehouse.indexOf("async function openSalesOrderDetail");
    const openEnd = warehouse.indexOf("async function applySalesOrderRouteFromUrl", openStart);
    const openSource = warehouse.slice(openStart, openEnd);
    assert.ok(openStart >= 0 && openEnd > openStart);
    assert.match(openSource, /if \(syncHistory\) syncSalesOrderRoute\(normalizedOrderId\)/);
    assert.match(openSource, /const open = async \(\) => \{[\s\S]*?requestPortalOrderDetail\(orderId\)/);
    assert.doesNotMatch(openSource, /getSalesOrderIdFromUrl\(\) !== normalizedOrderId/);
});

test("back, forward, direct links, and section changes keep order UI and URL in sync", () => {
    assert.match(warehouse, /if \(!requestedSection && getSalesOrderIdFromUrl\(\)\) return "orders"/);
    assert.match(warehouse, /function closeSalesOrderDocument\([\s\S]*?window\.history\.back\(\)/);
    assert.match(warehouse, /syncSalesOrderRoute\("", \{ replace: true \}\)/);
    assert.match(warehouse, /section !== "orders" && section !== "shipped" && getSalesOrderIdFromUrl\(\)/);
    assert.match(warehouse, /openSalesOrderDetail\(orderId,[\s\S]*?syncHistory: false/);
});

