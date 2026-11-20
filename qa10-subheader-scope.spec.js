const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const index = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function readFunction(name, nextName) {
    const start = index.indexOf(`        function ${name}`);
    const end = index.indexOf(`        function ${nextName}`, start + 1);
    assert.ok(start >= 0 && end > start, `Could not extract ${name}.`);
    return index.slice(start, end);
}

const formatterSource = readFunction("formatActiveWorkspaceScopeLabel", "formatCompanyWarehouseSummary");

function formatScope({ company = "", companyDisplay = "", assignment = null, location = {} } = {}) {
    return new Function("context", `
        const getActiveCompany = context.getActiveCompany;
        const formatCompanySelectorLabel = context.formatCompanySelectorLabel;
        const getActiveWarehouseAssignment = context.getActiveWarehouseAssignment;
        const getFulfillmentLocationByCode = context.getFulfillmentLocationByCode;
        ${formatterSource}
        return formatActiveWorkspaceScopeLabel();
    `)({
        getActiveCompany: () => company,
        formatCompanySelectorLabel: () => companyDisplay,
        getActiveWarehouseAssignment: () => assignment,
        getFulfillmentLocationByCode: () => location
    });
}

test("sub-header identifies the selected company and warehouse", () => {
    assert.equal(formatScope({
        company: "CODEX PORTAL SYSTEM TEST",
        companyDisplay: "CODEX PORTAL SYSTEM TEST (ON)",
        assignment: { locationCode: "GW3PL-MISS", locationName: "Grey Wolf Mississauga" }
    }), "CODEX PORTAL SYSTEM TEST (ON) | GW3PL-MISS - Grey Wolf Mississauga");
});

test("sub-header does not imply a warehouse when none is selected", () => {
    assert.equal(formatScope({
        company: "CODEX PORTAL SYSTEM TEST",
        companyDisplay: "CODEX PORTAL SYSTEM TEST (ON)"
    }), "CODEX PORTAL SYSTEM TEST (ON) | No warehouse selected");
});

test("global scope explicitly includes all warehouses", () => {
    assert.equal(formatScope(), "All companies | All warehouses");
});

test("company and warehouse changes both refresh the shared sub-header formatter", () => {
    const activeCompanyUi = readFunction("updateActiveCompanyUi", "renderCompanySelectionRecovery");
    const activeWarehouse = readFunction("setActiveWarehouse", "normalizeProvinceCode");
    assert.match(activeCompanyUi, /refreshActiveWarehouseSelector\(\)[\s\S]*formatActiveWorkspaceScopeLabel\(\)/);
    assert.match(activeWarehouse, /updateActiveCompanyUi\(\)/);
});
