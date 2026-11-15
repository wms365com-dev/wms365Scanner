"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const portal = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("warehouse inventory surfaces distinguish physical, committed, and allocatable quantities", () => {
    assert.match(warehouse, /Physical On Hand/);
    assert.match(warehouse, /Committed to Active Work/);
    assert.match(warehouse, /Available to Allocate/);
    assert.match(warehouse, /Pickable on hand \$\{formatTrackedQuantity\(item\.onHandQuantity/);
    assert.match(warehouse, /Committed \$\{formatTrackedQuantity\(item\.reservedQuantity/);
    assert.match(warehouse, /Available to allocate \$\{formatTrackedQuantity\(item\.availableQuantity/);
});

test("customer portal explains the reservation deduction without exposing other scopes", () => {
    assert.match(portal, /available to order/);
    assert.match(portal, /Pickable On Hand/);
    assert.match(portal, /Reserved for Active Work/);
    assert.match(server, /greatest\(h\.pickable_quantity - coalesce\(r\.reserved_quantity, 0\) - coalesce\(kr\.reserved_quantity, 0\), 0\)::integer as available_quantity/);
    assert.match(server, /where o\.account_name = \$1/);
});

test("quantity clarity is display-only and preserves allocation authorization", () => {
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserPortalOrderWarehouseAccess\(/);
    const warehouseMeta = warehouse.match(/function updateWarehouseSalesOrderLineMeta\(card\) \{[\s\S]*?\n        \}/)?.[0] || "";
    const portalInventory = portal.match(/function renderInventory\(\) \{[\s\S]*?\n        \}/)?.[0] || "";
    assert.doesNotMatch(warehouseMeta, /requestJson|fetch\(|\.availableQuantity\s*=/);
    assert.doesNotMatch(portalInventory, /requestJson|fetch\(|\.availableQuantity\s*=/);
});
