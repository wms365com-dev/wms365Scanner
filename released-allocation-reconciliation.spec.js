"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "scripts", "reconcile-released-order-allocations.js"), "utf8");
const { loadPlan } = require("./scripts/reconcile-released-order-allocations");

test("released allocation correction is dry-run by default and requires an exact plan hash", () => {
    assert.match(script, /begin transaction isolation level repeatable read read only/);
    assert.match(script, /Apply requires --confirm=\$\{APPLY_CONFIRMATION\} and the exact 24-character --plan-hash/);
    assert.match(script, /if \(plan\.planHash !== options\.planHash\) throw new Error\("The allocation plan changed after preflight/);
    assert.match(script, /select pg_advisory_xact_lock\(hashtext\('wms365:ops05:released-allocation-reconciliation'\)\)/);
});

test("only untouched released orders are eligible for automatic reconciliation", () => {
    assert.match(script, /where o\.status = 'RELEASED'/);
    assert.match(script, /not exists \(select 1 from pick_confirmations p where p\.order_id = o\.id\)/);
    assert.match(script, /wt\.task_type = 'PICK'[\s\S]*?wt\.status in \('IN_PROGRESS', 'DONE', 'BLOCKED'\)/);
    assert.match(script, /line_stats\.short_line_count > 0/);
    assert.match(script, /allocation_stats\.non_pickable_allocation_count = 0/);
    assert.match(script, /select id from portal_orders where id = any\(\$1::bigint\[\]\) order by id for update/);
    assert.doesNotMatch(script, /status\s*=\s*'(?:PICKED|STAGED|SHIPPED)'/);
});

test("correction uses the normal allocator and verifies inventory and order facts are unchanged", () => {
    assert.match(script, /o\.account_name/);
    assert.match(script, /accountName: String\(row\.account_name \|\| ""\)/);
    assert.match(script, /getPortalOrderById\(client, target\.id, target\.accountName\)/);
    assert.match(script, /allocatePortalOrderInventory\(client, order/);
    assert.match(script, /before\.inventoryHash !== after\.inventoryHash/);
    assert.match(script, /before\.orderHash !== after\.orderHash/);
    assert.match(script, /mismatched_lines/);
    assert.match(script, /non_pickable_allocations/);
    assert.match(script, /if \(remainingPlan\.rows\.length\) throw new Error/);
});

test("the plan carries account scope internally and binds it into the confirmation hash", async () => {
    const row = {
        id: "42",
        account_name: "TENANT A",
        updated_at: "2026-11-16T12:00:00.000Z",
        split_fulfillment_approved: false,
        line_count: 1,
        short_line_count: 1,
        shortage: 2,
        non_pickable_allocation_count: 0,
        allocation_quantity: 0
    };
    const first = await loadPlan({ query: async () => ({ rows: [row] }) });
    const second = await loadPlan({ query: async () => ({ rows: [{ ...row, account_name: "TENANT B" }] }) });

    assert.equal(first.rows[0].accountName, "TENANT A");
    assert.notEqual(first.planHash, second.planHash);
});

test("server exports the production allocator without introducing a correction endpoint", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(server, /allocatePortalOrderInventory,/);
    assert.doesNotMatch(server, /app\.(?:post|put|patch)\([^\n]*reconcile-released-order-allocations/);
});

test("sandbox workflow is pinned to the designated company and always rolls back", () => {
    const verifier = fs.readFileSync(
        path.join(__dirname, "scripts", "verify-test-company-released-allocation-reconciliation.js"),
        "utf8"
    );
    assert.match(verifier, /requireSandboxConfiguration\(process\.env\)/);
    assert.match(verifier, /requireDesignatedTestCompany\(client\)/);
    assert.match(verifier, /begin transaction isolation level serializable/);
    assert.match(verifier, /await verifyOrder\(client, order\.id\)/);
    assert.match(verifier, /getPortalOrderById\(client, target\.id, target\.accountName\)/);
    assert.match(verifier, /inventoryQuantityChanged: false/);
    assert.match(verifier, /finally \{[\s\S]*?await client\.query\("rollback"\)/);
});
