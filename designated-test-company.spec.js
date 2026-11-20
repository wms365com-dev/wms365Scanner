const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DESIGNATED_TEST_COMPANY, requireDesignatedTestCompany } = require("./scripts/designated-test-company");

const validCompany = { ...DESIGNATED_TEST_COMPANY, is_active: true };

test("test company is pinned to the verified ID and exact name", async () => {
    assert.deepEqual(DESIGNATED_TEST_COMPANY, { id: "1510", name: "CODEX PORTAL SYSTEM TEST" });
    assert.equal(Object.isFrozen(DESIGNATED_TEST_COMPANY), true);
    let calls = 0;
    const company = await requireDesignatedTestCompany({ query: async (sql, parameters) => {
        calls += 1;
        assert.match(sql, /where id = \$1 and name = \$2 and is_active = true/);
        assert.doesNotMatch(sql, /ilike|like|limit 1/i);
        assert.deepEqual(parameters, ["1510", "CODEX PORTAL SYSTEM TEST"]);
        return { rows: [validCompany] };
    } });
    assert.equal(company, DESIGNATED_TEST_COMPANY);
    assert.equal(calls, 1);
});

for (const [scenario, rows] of [
    ["missing", []],
    ["inactive", [{ ...validCompany, is_active: false }]],
    ["same name but different ID", [{ ...validCompany, id: "1896" }]],
    ["same ID but changed name", [{ ...validCompany, name: "Customer Company" }]],
    ["another Codex company", [{ ...validCompany, id: "491", name: "CODEX UX TEST 202605112319" }]],
    ["ambiguous result", [validCompany, validCompany]]
]) {
    test(`test-company guard rejects ${scenario} without a fallback`, async () => {
        let calls = 0;
        await assert.rejects(requireDesignatedTestCompany({ query: async () => {
            calls += 1;
            return { rows };
        } }), /Testing stopped.*no customer-company fallback/);
        assert.equal(calls, 1);
    });
}

test("lookup failure stops testing without trying another company", async () => {
    let calls = 0;
    await assert.rejects(requireDesignatedTestCompany({ query: async () => {
        calls += 1;
        throw new Error("Database unavailable");
    } }), /Database unavailable/);
    assert.equal(calls, 1);
});

const guardedScripts = [
    "scripts/verify-test-company-platform-flow.js",
    "scripts/verify-test-company-bol-flow.js",
    "scripts/verify-test-company-inventory-move-flow.js",
    "scripts/verify-test-company-shopify-shared-pool.js",
    "scripts/verify-test-company-pallet-pick-reallocation.js",
    "scripts/verify-test-company-draft-cancellation.js",
    "scripts/verify-test-company-order-duplicate.js",
    "scripts/verify-test-company-routing-readiness.js",
    "scripts/audit-platform-release-data.js",
    "verify-portal-inventory-database.js"
];

for (const file of guardedScripts) {
    test(`${file} uses the fixed test-company guard before transaction writes`, () => {
        const source = readFileSync(path.join(__dirname, file), "utf8");
        assert.match(source, /await requireDesignatedTestCompany\((client|pool)\)/);
        assert.doesNotMatch(source, /TEST%COMPANY|WMS365 TEST COMPANY/);
        const guardPosition = source.indexOf("await requireDesignatedTestCompany(");
        const firstWrite = source.search(/`\s*(insert into|update|delete from)/i);
        if (firstWrite >= 0) {
            assert.ok(guardPosition < firstWrite);
            assert.match(source, /await client.query\("rollback"\)/);
            assert.doesNotMatch(source, /client.query\("commit"\)/i);
        }
    });
}

test("sole-warehouse fixture changes only the designated company and always rolls back", () => {
    const source = readFileSync(path.join(__dirname, "verify-portal-inventory-database.js"), "utf8");
    assert.match(source, /delete from company_fulfillment_locations\s+where account_name = \$1 and fulfillment_location_id <> \$2/);
    assert.match(source, /\[accountName, fulfillmentLocationId\]/);
    assert.match(source, /finally\s*\{\s*await client.query\("rollback"\)/);
});
