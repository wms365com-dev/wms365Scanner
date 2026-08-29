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
