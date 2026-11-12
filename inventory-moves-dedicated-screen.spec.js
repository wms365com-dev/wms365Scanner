const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const desktop = fs.readFileSync("index.html", "utf8");

test("inventory moves has a focused top-level screen", () => {
    assert.match(desktop, /data-section="moves"/);
    assert.match(desktop, /syncInventoryActionScreen/);
    assert.match(desktop, /transferInventoryCard.*investigationHoldCard.*putAwayInventoryCard.*moveInventoryCard/s);
    assert.match(desktop, /customerKittingRequestsCard.*adjustInventoryCard.*convertInventoryCard.*inventoryActionsRecentActivityCard/s);
});

test("move location fields support typing and scanning", () => {
    assert.match(desktop, /Type or scan source location/);
    assert.match(desktop, /Type or scan destination location/);
    assert.match(desktop, /Type or scan source BIN/);
    assert.match(desktop, /list="transferFromList"/);
    assert.match(desktop, /list="moveToList"/);
});

test("inventory moves supports warehouse-scoped locations and up to five evidence images", () => {
    assert.match(desktop, /id="inventoryLocationCard"/);
    assert.match(desktop, /id="inventoryLocationWarehouse"/);
    assert.match(desktop, /Storage - pickable/);
    assert.match(desktop, /Damaged - not pickable/);
    assert.match(desktop, /id="transferImages"[^>]*multiple/);
    assert.match(desktop, /id="investigationImages"[^>]*multiple/);
    assert.match(desktop, /Choose no more than 5 images/);
    assert.match(desktop, /image\\\/jpeg\|image\\\/png\|image\\\/webp/);
    assert.match(desktop, /Each image must be under 4 MB/);
});
