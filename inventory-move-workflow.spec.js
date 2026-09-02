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
    assert.match(desktop, /inventoryLineMatches\.find\(\(line\) => Number\(line\.id\) === inventoryLineId\)/);
});

test("bin moves cannot silently become cross-warehouse transfers", () => {
    assert.match(server, /assertInventoryMoveWithinWarehouse/);
    assert.match(server, /A bin move cannot move stock between warehouses/);
    assert.match(server, /Create a stock transfer/);
});

test("warehouse workers receive move-only access with warehouse isolation", () => {
    assert.match(server, /INVENTORY_MOVE: "inventory_move"/);
    assert.match(server, /app\.post\("\/api\/transfer", requireInventoryMovePermission\(\)/);
    assert.match(server, /assertAppUserInventoryMoveAccess/);
    assert.match(server, /Stock can only be moved between locations in the same warehouse/);
    assert.match(server, /filterInventoryRowsForFulfillmentLocationIds/);
    assert.match(server, /filterLocationMasterRowsForAppUser/);
});

test("moves are idempotent and store QC or damage evidence", () => {
    assert.match(server, /inventory_movements where movement_key = \$1/);
    assert.match(server, /createInventoryMovementRecord/);
    assert.match(server, /inventory_movement_attachments/);
    assert.match(server, /Upload up to \$\{MAX_INVENTORY_MOVE_IMAGES\} QC or damage images/);
    assert.match(server, /JPEG, PNG, or WebP image/);
});
