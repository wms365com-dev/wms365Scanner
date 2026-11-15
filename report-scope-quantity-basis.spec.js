"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

function functionSource(name, nextName) {
    const pattern = new RegExp(`function ${name}\\([\\s\\S]*?(?=\\n        function ${nextName}\\()`);
    return warehouse.match(pattern)?.[0] || "";
}

test("reports show their permitted-company scope and physical on-hand quantity basis", () => {
    assert.match(warehouse, /id="reportScopeSummary"/);
    assert.match(warehouse, /Report scope: all permitted companies/);
    assert.match(warehouse, /Quantity basis: physical on-hand inventory; pallet totals are reported separately/);
    assert.match(warehouse, /Physical On-Hand Units \/ Cases/);
    assert.match(warehouse, /Physical On-Hand Qty/);
    assert.match(warehouse, /Physical On-Hand Pallets/);
});

test("CSV and print reports retain scope and quantity-basis metadata", () => {
    assert.match(warehouse, /\["Report Scope", context\.label\]/);
    assert.match(warehouse, /\["Quantity Basis", context\.quantityBasis\]/);
    assert.match(warehouse, /PhysicalOnHandPallets/);
    assert.match(warehouse, /PhysicalOnHandCases/);
    assert.match(warehouse, /PhysicalOnHandUnits/);
    assert.match(warehouse, /PhysicalOnHandQty/);
    assert.match(warehouse, /<p>Report Scope: \$\{esc\(reportContext\.label\)\}<\/p>/);
    assert.match(warehouse, /<p>Quantity Basis: \$\{esc\(reportContext\.quantityBasis\)\}<\/p>/);
});

test("all report paths pass the resolved company scope explicitly", () => {
    const render = functionSource("renderReports", "renderInventoryCountReview");
    const print = functionSource("printReports", "reportTableMarkup");
    assert.match(render, /getLocationReportRows\(filterText, ownerFilter\)/);
    assert.match(render, /getItemReportRows\(filterText, ownerFilter\)/);
    assert.match(print, /getLocationReportRows\(ui\.reportFilter\.value, ownerFilter\)/);
    assert.match(print, /getItemReportRows\(ui\.reportFilter\.value, ownerFilter\)/);
});

test("report row builders preserve tenant filtering without hidden DOM dependencies", () => {
    const locations = functionSource("getLocationReportRows", "getItemReportRows");
    const items = functionSource("getItemReportRows", "getOwnerReportRows");
    assert.match(locations, /getScopedCompanyValue\(ownerFilter\)/);
    assert.match(locations, /filterInventoryByOwner\(scopedOwnerFilter\)/);
    assert.doesNotMatch(locations, /ui\.reportOwner/);
    assert.match(items, /getScopedCompanyValue\(ownerFilter\)/);
    assert.match(items, /filterInventoryByOwner\(scopedOwnerFilter\)/);
    assert.doesNotMatch(items, /ui\.reportOwner/);
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserPortalOrderWarehouseAccess\(/);
});

test("report totals continue to use recorded physical inventory quantities", () => {
    const items = functionSource("getItemReportRows", "getOwnerReportRows");
    assert.match(items, /current\.totalUnits \+= line\.quantity/);
    assert.doesNotMatch(items, /availableQuantity|reservedQuantity|pickableQuantity/);
});
