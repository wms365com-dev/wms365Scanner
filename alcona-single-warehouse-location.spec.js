const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("single-warehouse companies resolve legacy bins to their assigned warehouse", () => {
    const functionStart = source.indexOf("async function resolveFulfillmentLocationFromScopedLocation");
    const functionEnd = source.indexOf("async function assertCompanyLocationScopedForMultiWarehouse", functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const implementation = source.slice(functionStart, functionEnd);
    assert.match(implementation, /if \(warehouses\.length === 1\) return warehouses\[0\];/);
    assert.match(implementation, /find\(\(warehouse\) => isLocationScopedToFulfillmentWarehouse/);
});

test("allocation summaries inherit the sole company warehouse for legacy bin names", () => {
    assert.match(source, /join portal_orders allocation_order on allocation_order\.id = allocation_line\.order_id/);
    assert.match(source, /company_location\.account_name = allocation_order\.account_name/);
    assert.match(source, /other_location\.fulfillment_location_id <> company_location\.fulfillment_location_id/);
});

test("active pick tickets cannot print with missing locations", () => {
    assert.match(source, /Pick ticket blocked for \$\{order\.orderCode \|\| "this order"\}: assign pick locations/);
    assert.match(source, /\["RELEASED", "PICKED", "STAGED"\]\.includes\(status\)/);
});
