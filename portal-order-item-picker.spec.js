const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

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

test("order entry explains warehouse-specific stock and offers a warehouse switch", () => {
    assert.match(portalHtml, /function getItemWarehouseAvailability\(item\)/);
    assert.match(portalHtml, /function formatItemWarehouseAvailability\(item\)/);
    assert.match(portalHtml, /SHIP-FROM WAREHOUSE AND STOCK WAREHOUSE DO NOT MATCH/);
    assert.match(portalHtml, /INSUFFICIENT STOCK AT SHIP-FROM WAREHOUSE/);
    assert.match(portalHtml, /Other warehouse stock:/);
    assert.match(portalHtml, /data-use-order-warehouse/);
    assert.match(portalHtml, /Change ship-from to this warehouse/);
    assert.match(portalHtml, /function renderSavedOrderStockWarnings\(order, warnings\)/);
    assert.match(portalHtml, /Select Edit Draft and change Ship From Warehouse before releasing/);
});

test("warehouse availability deducts reservations only from their assigned warehouse", () => {
    assert.match(serverSource, /group by o\.fulfillment_location_id, l\.sku/);
    assert.match(serverSource, /r\.fulfillment_location_id = cfl\.fulfillment_location_id/);
    assert.match(serverSource, /upper\(i\.location\) = upper\(fl\.code\)/);
});

test("sales order form keeps warehouse selection and release readiness in the workflow", () => {
    assert.match(portalHtml, /id="orderWarehouseSelect"/);
    assert.match(portalHtml, /Stock shown below updates when this changes/);
    assert.match(portalHtml, /id="orderReleaseReadiness" aria-live="polite"/);
    assert.match(portalHtml, /Add at least one item before releasing the order/);
    assert.match(portalHtml, /Stock check passed for the selected warehouse/);
});

test("split warehouse release requires clear customer approval", () => {
    assert.match(portalHtml, /This order needs to ship from more than one warehouse/);
    assert.match(portalHtml, /I approve splitting this order based on where stock is available/);
    assert.match(portalHtml, /separate pick ticket, packing slip, and shipment update for each warehouse/);
    assert.match(portalHtml, /function buildOrderSplitPlan\(lines, selectedWarehouseId\)/);
    assert.match(portalHtml, /pendingReleaseSplitRequired && ui\.portalReleaseSplitApproved\?\.checked !== true/);
    assert.match(serverSource, /split_fulfillment_approved boolean not null default false/);
    assert.match(serverSource, /allowSplitFulfillment: splitFulfillmentApproved === true/);
    assert.match(serverSource, /Review the split and approve it before releasing the order/);
});
