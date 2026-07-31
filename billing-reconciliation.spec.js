const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("billing reconciliation compares completed operations with non-void events", () => {
    assert.match(source, /\/api\/billing\/reconciliation/);
    assert.match(source, /async function getBillingReconciliationReport/);
    assert.match(source, /INBOUND_RECEIPT/);
    assert.match(source, /OUTBOUND_ORDER/);
    assert.match(source, /be\.status <> 'VOID'/);
    assert.match(source, /status: Number\(row\.billing_event_count\) > 0 \? "MATCHED" : "MISSING"/);
});

test("billing reconciliation is company scoped for non-admin users", () => {
    assert.match(source, /getAccessibleCompanyNamesForAppUser\(client, appUser\)/);
    assert.match(source, /operation\.account_name = any/);
    assert.match(source, /assertAppUserCompanyAccess\(client, req\.appUser, accountName\)/);
});

