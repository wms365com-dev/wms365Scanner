"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("company-required empty states expose one reusable recovery action", () => {
    assert.match(warehouse, /function renderCompanySelectionRecovery\(message\)/);
    assert.match(warehouse, /data-company-selection-recovery/);
    assert.match(warehouse, /data-choose-company>Choose Company<\/button>/);
    assert.match(warehouse, /portalInboundsList\.innerHTML = company[\s\S]+renderCompanySelectionRecovery\(fallback\)/);
    assert.match(warehouse, /portalOrdersList\.innerHTML = company[\s\S]+renderCompanySelectionRecovery\(fallback\)/);
    assert.match(warehouse, /masterRecordListContent\.innerHTML = renderCompanySelectionRecovery/);
    assert.match(warehouse, /partnerList\.innerHTML = renderCompanySelectionRecovery/);
});

test("recovery action opens the visible official desktop or mobile selector", () => {
    assert.match(warehouse, /const chooseCompanyButton = event\.target\.closest\("\[data-choose-company\]"\)/);
    assert.match(warehouse, /function focusOfficialCompanySelector\(\)/);
    assert.match(warehouse, /ui\.mobileActiveCompany\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
    assert.match(warehouse, /ui\.desktopCompanySwitcher\.open = true/);
    assert.match(warehouse, /renderCompanySwitcherList\(\)/);
    assert.match(warehouse, /window\.setTimeout\(\(\) => ui\.companySwitcherSearch\?\.focus\(\), 0\)/);
    assert.match(warehouse, /id="activeCompany"/);
    assert.match(warehouse, /id="mobileActiveCompany"/);
});

test("company recovery does not bypass server-side company or warehouse authorization", () => {
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserPortalOrderWarehouseAccess\(/);
    assert.match(server, /async function assertAppUserFulfillmentLocationAccess\(/);
    assert.doesNotMatch(warehouse, /data-choose-company[^>]+data-company-id=/);
});

test("clearing company scope cannot be undone by stale display labels", () => {
    const activeCompanyFunction = warehouse.match(/function getActiveCompany\(\) \{[\s\S]*?\n        \}/)?.[0] || "";
    assert.match(activeCompanyFunction, /ui\.activeCompany\?\.value/);
    assert.match(activeCompanyFunction, /state\.preferences\.activeCompany/);
    assert.match(activeCompanyFunction, /mobileCompanyContext/);
    assert.doesNotMatch(activeCompanyFunction, /workspaceCompanyChip/);
    assert.doesNotMatch(activeCompanyFunction, /activeCompanyDisplay/);
});
