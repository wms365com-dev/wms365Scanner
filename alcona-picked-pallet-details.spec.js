const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const mobileSource = fs.readFileSync(path.join(root, "mobile-pick.html"), "utf8");

test("Alcona picked status requires pallet-level location and weight", () => {
    assert.match(serverSource, /Enter every picked pallet's actual bin and weight/);
    assert.match(serverSource, /reallocatePortalOrderToActualPalletLocations/);
    assert.match(serverSource, /PORTAL_ORDER_PALLET_REALLOCATION/);
    assert.match(serverSource, /does not have one uncommitted pallet/);
    assert.match(serverSource, /Actual pick bin/);
    assert.match(serverSource, /picked_pallet_details = \$3::jsonb/);
    assert.match(serverSource, /outbound_total_pallets = case[\s\S]*jsonb_array_length\(\$3::jsonb\)/);
});

test("actual pallet-bin substitutions preserve customer, warehouse, and pickable-stock boundaries", () => {
    assert.match(serverSource, /where i\.account_name = \$1[\s\S]*and i\.sku = \$2[\s\S]*upper\(i\.location\) = any\(\$3::text\[\]\)/);
    assert.match(serverSource, /assertWarehouseLocationIsolation\(client, \{[\s\S]*purpose: "Actual pick bin"/);
    assert.match(serverSource, /row\.bin_is_pickable !== true/);
    assert.match(serverSource, /row\.bin_account_name/);
    assert.match(serverSource, /row\.bin_fulfillment_location_id/);
    assert.match(serverSource, /a\.order_id <> \$2/);
});

test("desktop and mobile picking collect pallet-level evidence", () => {
    assert.match(desktopSource, /data-picked-pallet-location/);
    assert.match(desktopSource, /data-picked-pallet-weight/);
    assert.match(mobileSource, /data-mobile-pallet-location/);
    assert.match(mobileSource, /data-mobile-pallet-weight/);
});
