"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selfTest } = require("./scripts/audit-ranchers-shopify-delivery-reconciliation-readonly");

test("independent Shopify delivery audit rejects foreign scopes and incomplete package evidence", () => {
    assert.deepEqual(selfTest(),{selfTest:"PASS",checks:10});
});
