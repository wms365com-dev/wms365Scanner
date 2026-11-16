const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
    resolvePortalAllocationReservationScopeIds
} = require("./server.js");

const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const allocatorSource = serverSource.slice(
    serverSource.indexOf("async function allocatePortalOrderInventory"),
    serverSource.indexOf("async function releasePortalOrderForAccount")
);

test("single-warehouse allocation reserves demand only in that warehouse", () => {
    assert.deepEqual(resolvePortalAllocationReservationScopeIds({
        fulfillmentLocationId: "143"
    }), [143]);
});

test("shared inventory pools reserve demand across unique configured pool warehouses", () => {
    assert.deepEqual(resolvePortalAllocationReservationScopeIds({
        portalInventoryPoolEnabled: true,
        portalInventoryPoolSourceIds: [1, "143", 1, 0, null]
    }), [1, 143]);
});

test("approved split fulfillment preserves account-wide reservation behavior", () => {
    assert.deepEqual(resolvePortalAllocationReservationScopeIds({
        allowSplitFulfillment: true,
        portalInventoryPoolEnabled: true,
        portalInventoryPoolSourceIds: [1, 143],
        fulfillmentLocationId: 1
    }), []);
});

test("legacy unassigned orders remain conservatively reserved inside a scoped allocation", () => {
    assert.match(allocatorSource, /o\.fulfillment_location_id = any\(\$5::bigint\[\]\)[\s\S]*o\.fulfillment_location_id is null/);
});

test("requested and allocated legacy reservations use the same warehouse scope", () => {
    const scopeUses = allocatorSource.match(/\$\{reservationScopeSql\}/g) || [];
    assert.equal(scopeUses.length, 2);
    assert.match(allocatorSource, /join portal_order_lines[\s\S]*l\.sku = any\(\$4::text\[\]\)[\s\S]*\$\{reservationScopeSql\}/);
    assert.match(allocatorSource, /join portal_order_allocations[\s\S]*a\.sku = any\(\$4::text\[\]\)[\s\S]*\$\{reservationScopeSql\}/);
});
