"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

function functionSource(name, nextName) {
    const start = warehouse.indexOf(`function ${name}(`);
    const end = warehouse.indexOf(`function ${nextName}(`, start + 1);
    assert.ok(start >= 0 && end > start, `${name} source was not found`);
    return warehouse.slice(start, end);
}

test("draft sales-order lines share one scan and type-ahead catalog", () => {
    assert.match(warehouse, /<datalist id="warehouseSalesOrderSkuChoices"><\/datalist>/);
    assert.match(warehouse, /<input data-warehouse-line-sku list="warehouseSalesOrderSkuChoices"[^>]+placeholder="Scan or search SKU, UPC, or description"/);
    assert.doesNotMatch(warehouse, /<select data-warehouse-line-sku>/);
    assert.match(warehouse, /function renderWarehouseSalesOrderSkuChoices\(\)[\s\S]*ui\.warehouseSalesOrderSkuChoices\.innerHTML = getWarehouseSalesOrderSelectableItems\(selectedSkus\)/);
});

test("type-ahead remains company scoped and resolves exact SKU UPC or description", () => {
    assert.match(warehouse, /getWarehouseSalesOrderInventoryChoices\(getWarehouseSalesOrderCompany\(\), editingWarehouseOrderId\)/);
    assert.match(warehouse, /item\.sku === candidate \|\| item\.upc === candidate \|\| norm\(item\.description\) === candidate/);
    assert.match(warehouse, /return matches\.length === 1 \? matches\[0\] : null/);
    assert.match(warehouse, /if \(item\) event\.target\.value = item\.sku/);
});

test("large catalogs are mounted once instead of once per order line", () => {
    const datalistCount = (warehouse.match(/id="warehouseSalesOrderSkuChoices"/g) || []).length;
    assert.equal(datalistCount, 1);
    assert.doesNotMatch(functionSource("addWarehouseOrderLine", "renderWarehouseSalesOrderContext"), /<option value=/);
    assert.match(functionSource("addWarehouseOrderLine", "renderWarehouseSalesOrderContext"), /if \(refreshChoices\) renderWarehouseSalesOrderSkuChoices\(\)/);
    assert.match(warehouse, /lines\.forEach\(\(line\) => addWarehouseOrderLine\(line, \{ refreshChoices: false \}\)\);\s*renderWarehouseSalesOrderSkuChoices\(\)/);
});

test("released orders hide draft line controls and server writes remain draft only", () => {
    assert.match(warehouse, /<div class="erp-lines-part" id="warehouseOrderLinesPart">[\s\S]*?id="warehouseSalesOrderSkuChoices"[\s\S]*?id="warehouseOrderLines"/);
    assert.doesNotMatch(warehouse, /<div class="erp-lines-part" id="warehouseOrderLinesPart">[\s\S]*?id="warehouseInboundLines"/);
    assert.match(warehouse, /ui\.warehouseOrderLinesPart\?\.classList\.toggle\("hidden", lockedOrder\)/);
    assert.match(warehouse, /const lockedOrder = !!currentOrder\?\.id && orderStatus !== "DRAFT"/);
    assert.match(warehouse, /const lineRows = order\.lines\.map\(\(line\) => \{[\s\S]*?<td>\$\{esc\(line\.sku\)\}<\/td>[\s\S]*?<td>\$\{esc\(line\.description \|\| ""\)\}<\/td>/);
    assert.match(server, /if \(existing\.status !== "DRAFT"\) \{\s*throw httpError\(400, "Released orders can no longer be edited\."\)/);
});
