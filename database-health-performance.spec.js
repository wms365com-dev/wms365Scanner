const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("database health readiness checks use one consolidated query", () => {
    const start = source.indexOf("async function runDatabaseHealthProbe");
    const end = source.indexOf("function ensureDatabaseHealthWatchdogStarted", start);
    const probe = source.slice(start, end);

    assert.match(probe, /exists\(select 1 from app_users where is_active = true\)/);
    assert.match(probe, /exists\(select 1 from app_sessions limit 1\)/);
    assert.match(probe, /exists\(select 1 from mobile_devices limit 1\)/);
    assert.match(probe, /exists\(select 1 from portal_vendor_access limit 1\)/);
    assert.equal((probe.match(/Database readiness checks timed out\./g) || []).length, 1);
    assert.doesNotMatch(probe, /Database ping timed out\./);
    assert.doesNotMatch(probe, /Warehouse login table check timed out\./);
});

test("health response exposes connection and readiness timing separately", () => {
    assert.match(source, /databaseConnectMs: probe\.connectMs/);
    assert.match(source, /databaseReadinessMs: probe\.readinessMs/);
});
