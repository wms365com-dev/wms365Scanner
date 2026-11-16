"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("sales-order document copy distinguishes new drafts from released workflow records", () => {
    assert.match(warehouse, /function getWarehouseSalesOrderDocumentCopy\(order = null\)/);
    assert.match(warehouse, /title: "New Sales Order"/);
    assert.match(warehouse, /title: `Draft Sales Order \$\{order\.orderCode\}`/);
    assert.match(warehouse, /title: `Sales Order \$\{order\.orderCode\}`/);
    assert.match(warehouse, /order details are read-only/);
    assert.doesNotMatch(warehouse, /ui\.warehouseOrderTitle\.textContent = order \? `Edit/);
});

test("released orders hide draft-only commands while retaining workflow actions", () => {
    assert.match(warehouse, /const lockedOrder = !!currentOrder\?\.id && orderStatus !== "DRAFT"/);
    assert.match(warehouse, /button\.hidden = lockedOrder/);
    assert.match(warehouse, /Viewing \$\{formatPortalOrderStatus\(orderStatus\)\} sales order/);
    assert.match(warehouse, /ui\.salesOrderCommandPickTicketBtn/);
    assert.match(warehouse, /ui\.salesOrderCommandRouteBtn/);
    assert.match(warehouse, /ui\.salesOrderCommandBolBtn/);
});

test("lifecycle language remains display-only and preserves existing workflow calls", () => {
    assert.match(warehouse, /warehouseOrderLead: document\.getElementById\("warehouseOrderLead"\)/);
    assert.match(warehouse, /renderWarehouseSalesOrderWorkflow\(order\)/);
    assert.doesNotMatch(warehouse, /requestJson\([^\n]*lifecycle-language/);
});

test("every lifecycle status has an executable human-readable formatter", () => {
    const match = warehouse.match(/function formatPortalOrderStatus\(status\) \{([\s\S]*?)\n        \}/);
    assert.ok(match, "sales-order status formatter must be defined");
    const norm = (value) => String(value || "").trim().toUpperCase();
    const formatPortalOrderStatus = new Function("norm", `return function(status) {${match[1]}}`)(norm);
    assert.deepEqual(
        ["DRAFT", "RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED", "CANCELLED"].map(formatPortalOrderStatus),
        ["Draft", "Released", "Picking", "Picked", "Staged", "Shipped", "Cancelled"]
    );
});
