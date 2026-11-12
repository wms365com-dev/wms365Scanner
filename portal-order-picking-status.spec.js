const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const mobile = fs.readFileSync(path.join(__dirname, "mobile-pick.html"), "utf8");
const migration = fs.readFileSync(path.join(__dirname, "migrations", "20261015_portal_order_picking_status.sql"), "utf8");

test("order lifecycle requires picking between released and picked", () => {
    assert.match(server, /RELEASED: "PICKING",\s*PICKING: "PICKED",\s*PICKED: "STAGED"/);
    assert.match(desktop, /if \(status === "RELEASED"\) return "PICKING";/);
    assert.match(desktop, /if \(status === "PICKING"\) return "PICKED";/);
    assert.match(desktop, /if \(status === "PICKING"\) return "Start Picking";/);
});

test("picking remains an active reservation and shortage state", () => {
    assert.match(server, /ACTIVE_PORTAL_ORDER_STATUSES = \["RELEASED", "PICKING", "PICKED", "STAGED"\]/);
    assert.match(server, /\["RELEASED", "PICKING"\]\.includes\(normalizePortalOrderStatus\(orderRow\.status\)\)/);
    assert.match(server, /normalizeText\(orderRow\.status\) !== "PICKING"/);
});

test("mobile starts picking before accepting scan confirmations", () => {
    assert.match(mobile, /status:'PICKING'/);
    assert.match(mobile, /MOBILE_PICK_START_PICKING/);
    assert.match(mobile, /status==='PICKING'\)return \{key:'pick',label:'Continue Picking'\}/);
});

test("database constraints accept picking for orders and shipments", () => {
    assert.match(migration, /portal_orders_status_check[\s\S]*'PICKING'/);
    assert.match(migration, /warehouse_shipments_status_check[\s\S]*'PICKING'/);
});
