const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

function functionBody(source, name, nextName) {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start);
    assert.notEqual(start, -1, `${name} must exist`);
    assert.notEqual(end, -1, `${nextName} boundary must exist`);
    return source.slice(start, end);
}

test("opened drafts cancel by stable id without depending on the compact order cache", () => {
    const cancel = functionBody(desktop, "deleteWarehouseSalesOrder", "getWarehouseInboundCompany");
    assert.match(cancel, /const orderId = String\(editingWarehouseOrderId\)/);
    assert.doesNotMatch(cancel, /if \(!currentOrder\?\.id\)/);
    assert.match(cancel, /requestJson\(`\/api\/admin\/portal-orders\/\$\{orderId\}\/status`/);
});

test("draft cancellation never saves the draft or revalidates its inventory", () => {
    const cancel = functionBody(desktop, "deleteWarehouseSalesOrder", "getWarehouseInboundCompany");
    assert.doesNotMatch(cancel, /saveWarehouseSalesOrderDraft|collectWarehouseSalesOrderPayload|available|allocate/i);
    assert.match(cancel, /status: "CANCELLED"/);
    assert.match(cancel, /"Idempotency-Key": actionId/);
});

test("successful cancellation updates the opened record before background list refresh", () => {
    const cancel = functionBody(desktop, "deleteWarehouseSalesOrder", "getWarehouseInboundCompany");
    const applied = cancel.indexOf("applyPortalOrderUpdate(response?.order");
    const refresh = cancel.indexOf("queuePortalOrderRefresh()");
    assert.ok(applied >= 0 && refresh > applied);
    assert.doesNotMatch(cancel, /await refreshPortalOrdersList/);
});

test("server cancellation releases allocations without running the release allocator", () => {
    const start = server.indexOf('if (nextStatus === "CANCELLED")', server.indexOf("async function updateAdminPortalOrderStatus"));
    const end = server.indexOf("const allowedTransitions", start);
    const cancellation = server.slice(start, end);
    assert.match(cancellation, /cancellableStatuses = \["DRAFT", "RELEASED", "PICKING", "PICKED", "STAGED"\]/);
    assert.match(cancellation, /delete from portal_order_allocations where order_id = \$1/);
    assert.match(cancellation, /status = 'CANCELLED'/);
    assert.doesNotMatch(cancellation, /allocatePortalOrder|available.*quantity|insufficient/i);
});
