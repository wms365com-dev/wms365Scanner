const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "scripts", "audit-active-order-allocation-integrity-readonly.js"), "utf8");

test("allocation integrity audit is transactionally read-only and aggregate-only", () => {
    assert.match(source, /begin read only/i);
    assert.match(source, /set local statement_timeout/i);
    assert.match(source, /await db\.query\("rollback"\)/);
    assert.doesNotMatch(source, /Promise\.all/);
    assert.doesNotMatch(source, /\b(insert|update|delete|alter|drop|truncate)\b\s+(?:into\s+)?(?:portal_|inventory_|bin_|item_)/i);
    assert.doesNotMatch(source, /orderCode|order_code|accountName\s*:/);
});

test("allocation integrity audit mirrors warehouse pool and pickability guards", () => {
    assert.match(source, /portal_inventory_rollup_location_id/);
    assert.match(source, /allow_storage/);
    assert.match(source, /NON_PICKABLE_TYPES/);
    assert.match(source, /MISSING_WAREHOUSE_SCOPE/);
    assert.match(source, /STOCK_AT_OTHER_WAREHOUSE/);
    assert.match(source, /STOCK_NON_PICKABLE_OR_HELD/);
    assert.match(source, /STOCK_IN_LEGACY_UNSCOPED_LOCATION/);
});
