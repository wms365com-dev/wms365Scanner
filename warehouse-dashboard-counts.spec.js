"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("dashboard and task endpoint request the complete active task scope", () => {
    assert.match(server, /getWarehouseTaskRowsForAppUser\(client, appUser, \{ activeOnly: true, limit: 0 \}\)/);
    assert.match(server, /app\.get\("\/api\/admin\/warehouse-tasks"[\s\S]*?activeOnly:[\s\S]*?limit: 0/);
});

test("warehouse task query enforces company and explicit warehouse scope", () => {
    const start = server.indexOf("async function getWarehouseTaskRowsForAppUser");
    const end = server.indexOf("async function getWarehouseTaskById", start);
    const source = server.slice(start, end);
    assert.match(source, /wt\.account_name = any/);
    assert.match(source, /getExplicitFulfillmentLocationIdsForAppUser\(client, appUser\)/);
    assert.match(source, /wt\.fulfillment_location_id = any/);
    assert.match(source, /const limitSql = boundedLimit/);
});

test("order history cap never excludes active outbound orders", () => {
    const start = server.indexOf("async function getPortalOrderList({");
    const end = server.indexOf("async function getPortalOrderListForAccount", start);
    const source = server.slice(start, end);
    assert.match(source, /with scoped_orders as/);
    assert.match(source, /recent_history as/);
    assert.match(source, /where status <> all\(/);
    assert.match(source, /where status = any\(/);
    assert.match(source, /or id in \(select id from recent_history\)/);
});
