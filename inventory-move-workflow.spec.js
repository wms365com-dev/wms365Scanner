const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const server = fs.readFileSync("server.js", "utf8");
const desktop = fs.readFileSync("index.html", "utf8");

test("item move accepts an exact lot or expiry inventory line", () => {
    assert.match(server, /inventoryLineId = toPositiveInt/);
    assert.match(server, /select \* from inventory_lines where id = \$1 for update/);
    assert.match(desktop, /Lot \/ Expiry Stock Line/);
    assert.match(desktop, /Choose the exact lot \/ expiry stock line to move/);
});

test("bin moves cannot silently become cross-warehouse transfers", () => {
    assert.match(server, /assertInventoryMoveWithinWarehouse/);
    assert.match(server, /A bin move cannot move stock between warehouses/);
    assert.match(server, /Create a stock transfer/);
});
