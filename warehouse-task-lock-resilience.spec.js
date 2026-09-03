const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("opening the mobile pick queue is read-only and does not rebuild every warehouse task", () => {
    const routeStart = serverSource.indexOf('app.get("/api/mobile/pick-orders"');
    const routeEnd = serverSource.indexOf('app.post("/api/mobile/put-away-confirmations"', routeStart);
    const routeSource = serverSource.slice(routeStart, routeEnd);
    assert.match(routeSource, /getMobilePickOrdersForAppUser\(pool/);
    assert.doesNotMatch(routeSource, /syncWarehouseTasksFromOperationalRecords/);
    assert.doesNotMatch(routeSource, /withTransaction/);
});

test("order status changes isolate retryable warehouse-task locks behind a savepoint", () => {
    assert.match(serverSource, /async function syncWarehouseTasksForOrderWithoutBlockingStatus/);
    assert.match(serverSource, /savepoint \$\{savepoint\}/);
    assert.match(serverSource, /rollback to savepoint \$\{savepoint\}/);
    assert.match(serverSource, /warehouseTaskSyncDeferred = true/);
    assert.match(serverSource, /await syncWarehouseTasksForOrderWithoutBlockingStatus\(client, updatedOrder, appUser\)/);
});
