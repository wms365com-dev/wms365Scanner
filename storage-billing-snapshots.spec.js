const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const migrationSource = fs.readFileSync(path.join(__dirname, "migrations", "20260731_storage_billing_snapshots.sql"), "utf8");

test("storage billing uses reviewed frozen snapshots in boot and migration schemas", () => {
    for (const source of [serverSource, migrationSource]) {
        assert.match(source, /create table if not exists storage_billing_snapshots/);
        assert.match(source, /status in \('DRAFT','REVIEWED','POSTED','VOID'\)/);
        assert.match(source, /unique \(account_name, billing_month\)/);
    }
    assert.match(serverSource, /async function captureStorageBillingSnapshot/);
    assert.match(serverSource, /async function reviewStorageBillingSnapshot/);
    assert.match(serverSource, /Capture and review the storage snapshot before generating storage billing/);
    assert.match(serverSource, /Generated from reviewed storage snapshot/);
    assert.match(serverSource, /set status='POSTED'/);
});

test("storage snapshot routes enforce finance and company access", () => {
    assert.match(serverSource, /app\.post\("\/api\/billing\/storage-snapshots"/);
    assert.match(serverSource, /app\.post\("\/api\/billing\/storage-snapshots\/:id\/review"/);
    assert.match(serverSource, /assertBillingFinanceAccess\(req\.appUser\)/);
    assert.match(serverSource, /assertAppUserCompanyAccess\(client, req\.appUser, current\.rows\[0\]\.account_name\)/);
});
