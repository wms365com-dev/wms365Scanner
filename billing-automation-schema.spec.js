const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("fresh boot and migration both create the company billing automation policy", () => {
    const server = fs.readFileSync("server.js", "utf8");
    const migration = fs.readFileSync("migrations/20260904_company_billing_automation.sql", "utf8");
    for (const source of [server, migration]) {
        assert.match(source, /create table if not exists company_billing_automation_policies/i);
        assert.match(source, /ALCONA TRADING LTD/);
        assert.match(source, /date '2026-09-01'/);
        assert.match(source, /charge_initial_storage_on_receipt/i);
    }
});

test("billing reconciliation is policy-scoped and duplicate protected", () => {
    const server = fs.readFileSync("server.js", "utf8");
    assert.match(server, /join company_billing_automation_policies p on p\.account_name = o\.account_name/);
    assert.match(server, /join company_billing_automation_policies p on p\.account_name = i\.account_name/);
    assert.match(server, /p\.is_enabled = true/g);
    assert.match(server, /not exists[\s\S]+email_delivery_log/);
    assert.match(server, /WAREHOUSE_BILLING:/);
    assert.match(server, /bcc: toEmail/);
});
