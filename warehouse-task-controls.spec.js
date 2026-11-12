const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("warehouse task transitions lock the row and ignore identical retries", () => {
    assert.match(serverSource, /select \* from warehouse_tasks where id = \$1 limit 1 for update/);
    assert.match(serverSource, /const isSameTransition =/);
    assert.match(serverSource, /return mapWarehouseTaskRow\(unchanged \|\| current\)/);
});

test("warehouse task claims cannot overwrite another worker", () => {
    assert.match(serverSource, /status === "IN_PROGRESS" && currentAssignee && assignedAppUserId/);
    assert.match(serverSource, /already assigned to another warehouse worker/);
});

test("blocked tasks require guidance and transition evidence is retained", () => {
    assert.match(serverSource, /status === "BLOCKED" && !blockedReason/);
    assert.match(serverSource, /nextAction/);
    assert.match(serverSource, /deviceId/);
    assert.match(serverSource, /metadata = coalesce\(metadata, '\{\}'::jsonb\) \|\| \$7::jsonb/);
});

