const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const index = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const access = fs.readFileSync(path.join(__dirname, "access.html"), "utf8");

test("authenticated scope shows company, active authorized warehouse, and role", () => {
  assert.match(index, /id="sessionScopeCompany"/);
  assert.match(index, /id="activeWarehouse"/);
  assert.match(index, /id="sessionScopeRole"/);
  assert.match(index, /getAuthorizedCompanyWarehouseAssignments/);
  assert.match(index, /warehouseUserRoleLabel\(appUser\?\.role/);
});

test("company scope updates the dashboard command filter", () => {
  assert.match(index, /id="desktopViewFilter">All companies/);
  assert.match(index, /ui\.desktopViewFilter\.textContent = companyDisplay \|\| "All companies"/);
});

test("company and account drawers render above sticky navigation", () => {
  const panelRule = index.match(/\.company-switcher-panel\s*\{[\s\S]*?\}/)?.[0] || "";
  assert.match(panelRule, /z-index:\s*1300/);
});

test("company profile shortcut hydrates the active company", () => {
  assert.match(index, /anchorId === "masterOwnerProfileCard"/);
  assert.match(index, /if \(owner\) loadCompanySetupIntoProfile\(owner\)/);
});

test("access choices explain which role should use each sign in", () => {
  assert.match(access, /Warehouse Staff Sign In/);
  assert.match(access, /Customer Portal Sign In/);
  assert.match(access, /receive, pick, stage, ship/);
});
