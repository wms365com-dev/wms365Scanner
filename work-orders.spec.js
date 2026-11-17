const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse exposes a dedicated Work Orders workspace", () => {
    assert.match(warehouse, /data-section="work-orders"/);
    assert.match(warehouse, /data-panel="work-orders"/);
    assert.match(warehouse, /Work Orders: All/);
    assert.match(warehouse, /id="workOrderStatusFilter"/);
    assert.match(warehouse, /id="workOrderSearch"/);
});

test("submitted customer projects are presented as released work orders", () => {
    assert.match(warehouse, /status === "SUBMITTED" \? "RELEASED"/);
    assert.match(warehouse, /data-status="IN_PROGRESS">Start Work/);
    assert.match(warehouse, /data-status="COMPLETED">Complete \/ Post/);
});

test("work order mutations require a dedicated permission", () => {
    assert.match(server, /WORK_ORDER_STATUS_UPDATE: "work_order_status_update"/);
    assert.match(server, /app\.post\("\/api\/admin\/kitting-requests\/:id\/status", requirePermission\(RBAC_PERMISSIONS\.WORK_ORDER_STATUS_UPDATE/);
    assert.match(server, /\[APP_USER_ROLES\.WAREHOUSE_WORKER\][\s\S]*?RBAC_PERMISSIONS\.WORK_ORDER_STATUS_UPDATE/);
});

test("work order transitions are sequential and terminal updates are idempotent", () => {
    assert.match(server, /SUBMITTED: Object\.freeze\(\["IN_PROGRESS", "CANCELLED"\]\)/);
    assert.match(server, /IN_PROGRESS: Object\.freeze\(\["COMPLETED", "CANCELLED"\]\)/);
    assert.match(server, /COMPLETED: Object\.freeze\(\[\]\)/);
    assert.match(server, /return \{ \.\.\.unchanged, statusChanged: false \}/);
    assert.match(server, /request\.statusChanged && \(status === "COMPLETED" \|\| status === "CANCELLED"\)/);
});

test("the Work Orders workspace does not instruct users to run a second inventory conversion", () => {
    const panelStart = warehouse.indexOf('id="workOrdersPanel"');
    const panelEnd = warehouse.indexOf('id="inventoryPanel"', panelStart);
    const panel = warehouse.slice(panelStart, panelEnd);
    assert.doesNotMatch(panel, /Convert Item/i);
    assert.match(panel, /Complete \/ Post|warehouse production/);
});
