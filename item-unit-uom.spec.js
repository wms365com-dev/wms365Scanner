const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    sanitizeItemMasterInput,
    mapItemMasterRow,
    mapPortalItemRow
} = require("./server");

const root = __dirname;
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const portalSource = fs.readFileSync(path.join(root, "portal.html"), "utf8");

test("item master keeps inventory tracking and unit UOM distinct", () => {
    const item = sanitizeItemMasterInput({
        accountName: "PACKFIRE",
        sku: "10125001",
        trackingLevel: "CASE",
        unitOfMeasure: "ea",
        unitsPerCase: 1
    });

    assert.equal(item.trackingLevel, "CASE");
    assert.equal(item.unitUom, "EA");
    assert.equal(item.unitsPerCase, 1);
});

test("item API row mappings return unit UOM without changing tracking level", () => {
    const row = {
        id: 1,
        account_name: "PACKFIRE",
        sku: "10125001",
        tracking_level: "CASE",
        unit_uom: "EA",
        created_at: new Date("2026-09-01T00:00:00Z"),
        updated_at: new Date("2026-09-01T00:00:00Z")
    };

    assert.deepEqual(
        [mapItemMasterRow(row).trackingLevel, mapItemMasterRow(row).unitUom],
        ["CASE", "EA"]
    );
    assert.deepEqual(
        [mapPortalItemRow(row).trackingLevel, mapPortalItemRow(row).unitUom],
        ["CASE", "EA"]
    );
});

test("database saves and item CSV workflows preserve unit UOM", () => {
    assert.match(serverSource, /add column if not exists unit_uom text not null default ''/);
    assert.match(serverSource, /tracking_level, unit_uom, units_per_case/);
    assert.match(serverSource, /unit_uom = excluded\.unit_uom/);
    assert.match(desktopSource, /id="masterItemUnitUom"/);
    assert.match(desktopSource, /"UNIT_UOM"/);
    assert.match(desktopSource, /\["UNITUOM", "UNITOFMEASURE", "EACHUOM", "EACHUNIT"\]/);
    assert.match(portalSource, /id="itemUnitUom"/);
    assert.match(portalSource, /unitUom: ui\.itemUnitUom\.value\.trim\(\)/);
    assert.match(portalSource, /unitUom: norm\(item\?\.unitUom \|\| ""\)/);
});
