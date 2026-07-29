const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");

test("customer portal inline script is valid JavaScript", () => {
    const scripts = [...portalHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    scripts.forEach((match) => new vm.Script(match[1]));
});

test("customer order entry includes a searchable item picker", () => {
    assert.match(portalHtml, /id="orderItemSearch"/);
    assert.match(portalHtml, /placeholder="Search SKU, description, or UPC"/);
    assert.match(portalHtml, /id="orderItemOptions"/);
    assert.match(portalHtml, /id="orderItemResults"/);
    assert.match(portalHtml, /Add Item &amp; Next/);
    assert.match(portalHtml, /function addSelectedOrderItem\(\)/);
    assert.match(portalHtml, /function getFilteredOrderItems\(value = ""\)/);
    assert.match(portalHtml, /function onOrderItemResultClick\(event\)/);
    assert.match(portalHtml, /renderOrderItemResults\(\{ open: true \}\)/);
});

test("duplicate order lines are blocked with a customer-facing alert", () => {
    assert.match(portalHtml, /function duplicateOrderItemMessage\(sku\)/);
    assert.match(portalHtml, /is already on this order/);
    assert.match(portalHtml, /window\.alert\(message\)/);
    assert.match(portalHtml, /const duplicateLine = lines\.find/);
});

test("new orders use one repeatable picker instead of creating a competing blank line", () => {
    assert.match(portalHtml, /const lines = order\?\.lines\?\.length \? order\.lines : \[\]/);
    assert.match(portalHtml, /function renderOrderLinesEmptyState\(\)/);
    assert.match(portalHtml, /ui\.orderItemSearch\.focus\(\)/);
});
