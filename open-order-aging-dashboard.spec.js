const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse dashboard exposes company open-order aging", () => {
    assert.match(source, /Open Orders by Company/);
    assert.match(source, /id="dashboardCompanyAging"/);
    assert.match(source, /0-2 days/);
    assert.match(source, /3-7 days/);
    assert.match(source, /8\+ days/);
});

test("aging dashboard uses permission-scoped open orders and drills into company orders", () => {
    assert.match(source, /const companyAging = summarizeOpenOrdersByCompany\(openOrders\)/);
    assert.match(source, /data-dashboard-company=/);
    assert.match(source, /setActiveCompany\(company, \{ force: true \}\)/);
    assert.match(source, /setSection\("orders"/);
});
