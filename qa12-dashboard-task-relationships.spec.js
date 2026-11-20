"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("dashboard distinguishes source orders from generated workflow tasks", () => {
    assert.match(source, /<span>Open Purchase Orders<\/span>/);
    assert.match(source, /<span>Open Sales Orders<\/span>/);
    assert.match(source, /<span>Active Workflow Tasks<\/span>/);
    assert.match(source, /Each purchase or sales order can create several workflow tasks, so task and order counts will not always match/);
    assert.match(source, /Tasks are workflow steps and may outnumber their source orders/);
});

test("blocked task count opens an explicitly filtered task list", () => {
    assert.match(source, /id="dashboardBlockedTasksBtn"[^>]*data-dashboard-popout="blocked-tasks"/);
    assert.match(source, /function getDashboardBlockedTasks\(\) \{[\s\S]*?getDashboardActiveTasks\(\)\.filter\(\(task\) => norm\(task\.status\) === "BLOCKED"\)/);
    assert.match(source, /type === "blocked-tasks" \? "blocked-tasks"/);
    assert.match(source, /normalizedType === "blocked-tasks" \? getDashboardBlockedTasks\(\)/);
    assert.match(source, /Blocked Warehouse Tasks/);
    assert.match(source, /dashboardBlockedTasksBtn\.classList\.toggle\("hidden", blockedTasks\.length === 0\)/);
});

test("blocked task rows preserve source-document drill-in behavior", () => {
    assert.match(source, /const isTaskList = normalizedType === "tasks" \|\| normalizedType === "blocked-tasks"/);
    assert.match(source, /rows\.map\(\(entry\) => isTaskList[\s\S]*?dashboardTaskRowMarkup\(entry, today\)/);
    assert.match(source, /data-open-warehouse-task=/);
    assert.match(source, /openWarehouseTaskSource\(taskButton\.dataset\.openWarehouseTask\)/);
});
