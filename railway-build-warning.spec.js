"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, ".railway", "railway.ts"), "utf8");

test("both WMS application builds remove obsolete npm production config before validation", () => {
    const safeCommand = "env -u NPM_CONFIG_PRODUCTION -u npm_config_production npm run check:deploy";
    assert.equal(source.split(safeCommand).length - 1, 2);
    assert.doesNotMatch(source, /buildCommand:\s*"npm run check:deploy"/);
});

test("warning suppression changes only the build validation environment", () => {
    assert.match(source, /start:\s*"node server\.js"/);
    assert.match(source, /healthcheck:\s*"\/api\/health"/);
    assert.doesNotMatch(source, /variables:\s*\{[^}]*NPM_CONFIG_PRODUCTION/s);
});
