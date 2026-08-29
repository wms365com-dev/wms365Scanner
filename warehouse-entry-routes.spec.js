const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("desktop and mobile warehouse entry routes require a session and serve the app", () => {
    assert.match(server, /app\.get\(\["\/desktop", "\/desktop\/"\][\s\S]*?await requireAppSession\(req\);[\s\S]*?sendWarehouseApp\(res\);/);
    assert.match(server, /app\.get\(\["\/mobile", "\/mobile\/"\][\s\S]*?await requireAppSession\(req\);[\s\S]*?sendWarehouseApp\(res\);/);
});

test("expired desktop and mobile sessions return users to login with a next path", () => {
    assert.match(server, /buildWarehouseLoginRedirect\(req, "\/desktop"\)/);
    assert.match(server, /buildWarehouseLoginRedirect\(req, "\/mobile"\)/);
});

test("production health fails when either warehouse entry route is missing", () => {
    assert.match(server, /const WAREHOUSE_ENTRY_ROUTE_HEALTH = \{ desktop: false, mobile: false \}/);
    assert.match(server, /entryRoutesReady = WAREHOUSE_ENTRY_ROUTE_HEALTH\.desktop && WAREHOUSE_ENTRY_ROUTE_HEALTH\.mobile/);
    assert.match(server, /const healthy = probe\.ok && entryRoutesReady/);
    assert.match(server, /WAREHOUSE_ENTRY_ROUTE_HEALTH\.desktop = true/);
    assert.match(server, /WAREHOUSE_ENTRY_ROUTE_HEALTH\.mobile = true/);
});

test("Railway runs the route contract before accepting a build", () => {
    const railway = JSON.parse(fs.readFileSync(path.join(__dirname, "railway.json"), "utf8"));
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    assert.equal(railway.build.buildCommand, "npm run check:deploy");
    assert.match(packageJson.scripts["check:deploy"], /warehouse-entry-routes\.spec\.js/);
});
