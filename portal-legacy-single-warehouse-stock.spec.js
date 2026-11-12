const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const start = source.indexOf("async function getPortalInventorySummary");
const end = source.indexOf("async function getPortalItemsForAccount", start);
const implementation = source.slice(start, end);

test("portal inventory maps unprefixed legacy bins only for a sole assigned warehouse", () => {
    assert.ok(start >= 0 && end > start);
    assert.match(implementation, /with assigned_scope as \(/);
    assert.match(implementation, /count\(\*\)::integer as assigned_warehouse_count/);
    assert.match(implementation, /scope\.assigned_warehouse_count = 1/);
    assert.match(implementation, /scope\.sole_fulfillment_location_id = cfl\.fulfillment_location_id/);
});

test("legacy fallback cannot claim a bin already named for another active warehouse", () => {
    assert.match(implementation, /not exists \([\s\S]*?from fulfillment_locations named_warehouse/);
    assert.match(implementation, /upper\(i\.location\) = upper\(named_warehouse\.code\)/);
    assert.match(implementation, /upper\(i\.location\) like upper\(named_warehouse\.code\) \|\| '-%'/);
});

test("multi-warehouse portal inventory keeps explicit warehouse prefix matching", () => {
    assert.match(implementation, /upper\(i\.location\) = upper\(fl\.code\)/);
    assert.match(implementation, /upper\(i\.location\) like upper\(fl\.code\) \|\| '-%'/);
    assert.match(implementation, /String\(entry\.fulfillmentLocationId\) === String\(selectedWarehouse\.fulfillmentLocationId\)/);
});
