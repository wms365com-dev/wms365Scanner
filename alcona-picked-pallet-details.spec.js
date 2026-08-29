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
    assert.match(serverSource, /is not allocated to this order/);
    assert.match(serverSource, /picked_pallet_details = \$3::jsonb/);
});

test("desktop and mobile picking collect pallet-level evidence", () => {
    assert.match(desktopSource, /data-picked-pallet-location/);
    assert.match(desktopSource, /data-picked-pallet-weight/);
    assert.match(mobileSource, /data-mobile-pallet-location/);
    assert.match(mobileSource, /data-mobile-pallet-weight/);
});
