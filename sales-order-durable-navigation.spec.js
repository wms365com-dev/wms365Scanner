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
    assert.match(warehouse, /window\.addEventListener\("popstate"/);
    assert.match(warehouse, /applySalesOrderRouteFromUrl\(\{ fromHistory: true \}\)/);
});

test("opening a listed order paints the scoped summary before fetching current detail", () => {
    assert.match(warehouse, /const summary = getPortalOrderById\(orderId\);[\s\S]*?if \(summary\) \{[\s\S]*?showSalesOrderDocument\(summary/);
    assert.match(warehouse, /requestJson\(`\/api\/admin\/portal-orders\/\$\{encodeURIComponent\(key\)\}`\)/);
    assert.match(warehouse, /if \(getSalesOrderIdFromUrl\(\) !== normalizedOrderId\) return null/);
    assert.doesNotMatch(warehouse, /localStorage[^\n]*(?:portalOrder|salesOrder)/i);
});

test("back, forward, direct links, and section changes keep order UI and URL in sync", () => {
    assert.match(warehouse, /if \(!requestedSection && getSalesOrderIdFromUrl\(\)\) return "orders"/);
    assert.match(warehouse, /function closeSalesOrderDocument\([\s\S]*?window\.history\.back\(\)/);
    assert.match(warehouse, /syncSalesOrderRoute\("", \{ replace: true \}\)/);
    assert.match(warehouse, /section !== "orders" && section !== "shipped" && getSalesOrderIdFromUrl\(\)/);
    assert.match(warehouse, /openSalesOrderDetail\(orderId,[\s\S]*?syncHistory: false/);
});

