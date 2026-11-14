"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("warehouse UI uses one canonical all-company scope label", () => {
    assert.doesNotMatch(warehouse, /All Companies/);
    assert.match(warehouse, /id="desktopUtilityCompany" hidden>All companies</);
    assert.match(warehouse, /id="desktopModuleCompany">All companies</);
    assert.match(warehouse, /id="activeCompanyDisplay">All companies</);
    assert.match(warehouse, /id="desktopFactboxCompany">All companies</);
    assert.match(warehouse, /id="feedbackContextCompany">All companies</);
});

test("company selectors retain the empty all-company sentinel", () => {
    assert.match(warehouse, /return \{ value, label: value \? formatCompanySelectorLabel\(value\) : "All companies" \}/);
    assert.match(warehouse, /options = \[\{ value: "", label: "All companies" \}\]\.concat\(options\)/);
    assert.match(warehouse, /<option value="">All companies<\/option>/);
});

test("display-only language change retains server-side company authorization", () => {
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserPortalOrderWarehouseAccess\(/);
    assert.match(warehouse, /id="activeCompany"/);
    assert.match(warehouse, /id="mobileActiveCompany"/);
});
