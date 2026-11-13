"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    ALLOWED_TASK_COUNT,
    assertExactTaskScope,
    requireSandboxConfiguration
} = require("./scripts/verify-test-company-authenticated-task-scope");

const script = fs.readFileSync(
    path.join(__dirname, "scripts", "verify-test-company-authenticated-task-scope.js"),
    "utf8"
);

function sandboxEnv(overrides = {}) {
    return {
        RAILWAY_ENVIRONMENT_NAME: "customer-sandbox",
        RAILWAY_SERVICE_NAME: "wms365-sandbox",
        RAILWAY_ENVIRONMENT_ID: "ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6",
        RAILWAY_SERVICE_ID: "98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b",
        WMS365_SANDBOX_EXTERNAL_SIDE_EFFECTS_DISABLED: "true",
        WMS365_SANDBOX_ORIGIN: "https://wms365-sandbox-customer-sandbox.up.railway.app",
        DATABASE_PRIVATE_URL: "postgresql://sandbox:secret@postgres-xihr.railway.internal:5432/railway",
        ...overrides
    };
}

test("sandbox guard accepts only the pinned isolated service, origin and private database", () => {
    const config = requireSandboxConfiguration(sandboxEnv());
    assert.equal(config.origin, "https://wms365-sandbox-customer-sandbox.up.railway.app");
    assert.match(config.connectionString, /postgres-xihr\.railway\.internal/);

    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ RAILWAY_ENVIRONMENT_NAME: "production" })), /customer-sandbox/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ RAILWAY_SERVICE_NAME: "wms365Scanner" })), /wms365-sandbox/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ WMS365_SANDBOX_ORIGIN: "https://app.wms365.co" })), /sandbox host/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ WMS365_SANDBOX_ORIGIN: "http://wms365-sandbox.local" })), /HTTPS origin/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ RAILWAY_ENVIRONMENT_ID: "production-id" })), /pinned customer-sandbox/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ DATABASE_PRIVATE_URL: "postgresql://fallback/railway" })), /Postgres-XihR/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ DATABASE_PRIVATE_URL: "", DATABASE_URL: "postgresql://public.example/railway" })), /private database URL/);
    assert.throws(() => requireSandboxConfiguration(sandboxEnv({ WMS365_SANDBOX_EXTERNAL_SIDE_EFFECTS_DISABLED: "false" })), /external email/);
});

test("scope reconciliation requires every allowed ID and rejects warehouse or company leaks", () => {
    assert.ok(ALLOWED_TASK_COUNT > 300);
    const expected = Array.from({ length: ALLOWED_TASK_COUNT }, (_, index) => String(index + 1));
    assert.equal(assertExactTaskScope({ tasks: expected.map((id) => ({ id })) }, expected, ["9001", "9002"]), ALLOWED_TASK_COUNT);
    assert.throws(
        () => assertExactTaskScope({ tasks: expected.slice(1).map((id) => ({ id })) }, expected, []),
        /scope mismatch/
    );
    assert.throws(
        () => assertExactTaskScope({ tasks: expected.concat("9001").map((id) => ({ id })) }, expected, ["9001"]),
        /scope mismatch|leaked/
    );
    assert.throws(
        () => assertExactTaskScope({ tasks: [{ id: "1" }, { id: "1" }] }, ["1", "1"], []),
        /duplicate/
    );
});

test("harness statically pins identity, commits fixtures, injects a session and always cleans up", () => {
    assert.match(script, /id: "1510", name: "CODEX PORTAL SYSTEM TEST"/);
    assert.match(script, /requireDesignatedTestCompany\(pool\)/);
    assert.match(script, /await client\.query\("commit"\)/);
    assert.match(script, /insert into app_sessions/);
    assert.match(script, /wms365_app_session=/);
    assert.match(script, /TEST-NO-PASSWORD-LOGIN/);
    assert.match(script, /finally \{[\s\S]*await cleanup\(pool, fixture\)/);
    assert.match(script, /delete from access_restriction_log/);
    assert.match(script, /delete from app_sessions/);
    assert.match(script, /delete from warehouse_tasks/);
    assert.match(script, /delete from warehouse_task_history/);
    assert.match(script, /set local session_replication_role = replica/);
    assert.match(script, /cleanupStaleScopeFixtures/);
    assert.match(script, /delete from fulfillment_locations/);
    assert.match(script, /delete from owner_accounts/);
    assert.match(script, /fixture cleanup left sandbox residue/);
});

test("harness exercises the real authenticated endpoint and denied-company response", () => {
    assert.match(script, /\/api\/admin\/warehouse-tasks\?accountName=/);
    assert.match(script, /allowedResponse\.status !== 200/);
    assert.match(script, /deniedResponse\.status !== 403/);
    assert.match(script, /DENIED-WH-/);
    assert.match(script, /DENIED-CO-/);
    assert.match(script, /count: ALLOWED_TASK_COUNT/);
});
