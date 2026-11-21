const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "scripts", "verify-test-company-shipped-order-sorting-browser.js"), "utf8");

test("browser verifier is pinned to isolated sandbox and exact test identities", () => {
    assert.match(source, /ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6/);
    assert.match(source, /98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b/);
    assert.match(source, /1510/);
    assert.match(source, /CODEX PORTAL SYSTEM TEST/);
    assert.match(source, /TEST-WMS-A/);
    assert.doesNotMatch(source, /app\.wms365\.co/);
});

test("browser verifier covers sorting, row opening, isolation, and cleanup", () => {
    assert.match(source, /data-sort-shipped-orders="shippedAt"/);
    assert.match(source, /aria-sort/);
    assert.match(source, /salesOrderId/);
    assert.match(source, /closeWarehouseOrderEntryBtn/);
    assert.match(source, /Sales Orders view/);
    assert.match(source, /delete from app_sessions/);
    assert.match(source, /delete from portal_orders/);
    assert.match(source, /cleanup left fixture residue/);
    assert.match(source, /fixtureResidueSource/);
});
