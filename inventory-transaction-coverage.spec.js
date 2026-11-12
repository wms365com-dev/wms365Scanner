const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const migration = fs.readFileSync(path.join(__dirname, "migrations", "20260731_inventory_ledger_context.sql"), "utf8");

test("ledger records warehouse and idempotency context", () => {
    assert.match(source, /resolveFulfillmentLocationFromScopedLocation\(client, lineIdentity\.accountName, lineIdentity\.location\)/);
    assert.match(source, /idempotency_key text not null default ''/);
    assert.match(source, /idempotencyKey: req\?\.body\?\.idempotency_key/);
    assert.match(migration, /idx_inventory_transactions_idempotency/);
});

test("allocation, unallocation, pick, ship, and reversal actions are ledgered", () => {
    assert.match(source, /async function recordPortalOrderAllocationTransactions/);
    assert.match(source, /PORTAL_ORDER_ALLOCATION/);
    assert.match(source, /PORTAL_ORDER_UNALLOCATION/);
    assert.match(source, /transactionType: "PICKING"/);
    assert.match(source, /transactionType: "SHIPPING"/);
    assert.match(source, /transactionType: "REVERSAL"/);
});

