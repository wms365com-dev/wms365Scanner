"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("scoped order reads expose duplicate relationships in both directions", () => {
    assert.match(server, /source_order\.id = o\.duplicated_from_order_id/);
    assert.match(server, /source_order\.account_name = o\.account_name/);
    assert.match(server, /replacement_order\.duplicated_from_order_id = o\.id/);
    assert.match(server, /replacement_order\.account_name = o\.account_name/);
    assert.match(server, /duplicatedFromOrderCode: row\.duplicated_from_order_code/);
    assert.match(server, /duplicatedToOrderCode: row\.duplicated_to_order_code/);
});

test("sales-order list and workflow show permission-checked related order links", () => {
    assert.match(warehouse, /function renderSalesOrderRelationship\(order/);
    assert.match(warehouse, /Copy of/);
    assert.match(warehouse, /Replacement/);
    assert.match(warehouse, /data-open-warehouse-order/);
    assert.match(warehouse, /Related sales order:/);
});

test("relationship visibility preserves duplicate idempotency and central access checks", () => {
    assert.match(server, /where duplicated_from_order_id = \$1 limit 1/);
    assert.match(server, /idx_portal_orders_duplicate_source/);
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserCustomerWarehouseAccess\(/);
    assert.doesNotMatch(warehouse, /requestJson\([^\n]*duplicate-relationship/);
});
