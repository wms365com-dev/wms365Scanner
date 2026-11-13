"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse session probe is quiet for absent or expired sessions", () => {
    assert.match(
        server,
        /app\.get\("\/api\/app\/me"[\s\S]*error\.statusCode === 401[\s\S]*status\(200\)\.json\(\{ authenticated: false, user: null \}\)/
    );
    assert.match(server, /app\.get\("\/api\/app\/me"[\s\S]*Cache-Control", "no-store"/);
});

test("warehouse bootstrap authenticates before initializing protected state", () => {
    const bootstrapCall = warehouse.indexOf("void bootstrapWarehouseApp();");
    const probe = warehouse.indexOf('requestJson("/api/app/me")', bootstrapCall);
    const authGate = warehouse.indexOf("if (!payload?.authenticated)", probe);
    const initialize = warehouse.indexOf("init();", authGate);
    const protectedState = warehouse.indexOf('requestJson("/api/state")');

    assert.ok(bootstrapCall >= 0, "warehouse bootstrap call is missing");
    assert.ok(probe > bootstrapCall, "session probe must begin bootstrap");
    assert.ok(authGate > probe, "session result must be checked");
    assert.ok(initialize > authGate, "application initialization must follow authentication");
    assert.ok(protectedState > initialize, "protected state loader must remain behind initialization");
    assert.match(
        warehouse.slice(authGate, initialize),
        /window\.location\.replace\("\/login\.html\?next=%2Fdesktop"\);[\s\S]*return;/
    );
});

test("protected requests still redirect on a real 401", () => {
    assert.match(
        warehouse,
        /if \(response\.status === 401 && !String\(url \|\| ""\)\.startsWith\("\/api\/portal\/"\)\)[\s\S]*window\.location\.href = "\/login"/
    );
});
