const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const inventoryStart = source.indexOf("async function getPortalInventorySummary");
const inventoryEnd = source.indexOf("async function getPortalItemsForAccount", inventoryStart);
const inventoryImplementation = source.slice(inventoryStart, inventoryEnd);
const releaseStart = source.indexOf("async function releasePortalOrderForAccount");
const releaseEnd = source.indexOf("async function releasePortalOrder(", releaseStart);
const releaseImplementation = source.slice(releaseStart, releaseEnd);

test("selected warehouse availability includes legacy reservations for a sole warehouse", () => {
    assert.match(inventoryImplementation, /when o\.fulfillment_location_id is null[\s\S]*?scope\.assigned_warehouse_count = 1[\s\S]*?then scope\.sole_fulfillment_location_id/);
    assert.match(inventoryImplementation, /o\.fulfillment_location_id is not null or scope\.assigned_warehouse_count = 1/);
});

test("selected warehouse availability subtracts active kitting reservations", () => {
    assert.match(inventoryImplementation, /kitting_reserved as \(/);
    assert.match(inventoryImplementation, /k\.status in \('SUBMITTED', 'IN_PROGRESS'\)/);
    assert.match(inventoryImplementation, /coalesce\(r\.reserved_quantity, 0\) \+ coalesce\(kr\.reserved_quantity, 0\)/);
});

test("release quantity enforcement is handled by the warehouse-aware allocator", () => {
    assert.match(releaseImplementation, /assertPortalOrderSkuAllowed\(client, normalizedAccount, line\.sku\);/);
    assert.doesNotMatch(releaseImplementation, /assertPortalOrderSkuAllowed\(client, normalizedAccount, line\.sku, line\.quantity\);/);
    assert.match(releaseImplementation, /await allocatePortalOrderInventory\(client, order/);
});
