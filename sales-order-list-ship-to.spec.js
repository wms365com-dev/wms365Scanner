"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("sales-order list displays a compact permission-scoped ship-to destination", () => {
    assert.match(warehouse, /function formatSalesOrderListShipTo\(order\)/);
    assert.match(warehouse, /<th>Ship To<\/th>/);
    assert.match(warehouse, /shipTo\.primary/);
    assert.match(warehouse, /shipTo\.secondary/);
    assert.match(warehouse, /order\?\.shipToName \|\| "Ship-to not set"/);
    assert.match(warehouse, /order\?\.shipToCity, order\?\.shipToState/);
});

test("customer pickup is identified without fabricating a delivery address", () => {
    assert.match(warehouse, /shipmentMethod \|\| ""\)\.toUpperCase\(\) === "CUSTOMER_PICKUP"/);
    assert.match(warehouse, /primary: "Customer pickup"/);
    assert.match(warehouse, /order\.fulfillmentLocationName \|\| order\.fulfillmentLocationCode \|\| "Assigned warehouse"/);
});

test("ship-to visibility reuses the existing scoped order response", () => {
    assert.match(warehouse, /const request = requestJson\(`\/api\/admin\/portal-orders\$\{query\}`\)/);
    assert.match(server, /app\.get\("\/api\/admin\/portal-orders"/);
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserPortalOrderWarehouseAccess\(/);
    assert.doesNotMatch(warehouse, /requestJson\([^\n]*ship-to-list/);
});
