const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");

test("catalog items remain selectable for draft orders when available stock is zero", () => {
    assert.match(portalHtml, /function getOrderEntryItems\(\)/);
    assert.match(portalHtml, /totalQuantity: 0/);
    assert.match(portalHtml, /warehouseAvailability: \[\]/);
    assert.match(portalHtml, /ui\.orderItemOptions\.innerHTML = getOrderEntryItems\(\)\.map/);
    assert.match(portalHtml, /const items = getOrderEntryItems\(\)\.filter/);
    assert.match(portalHtml, /OUT OF STOCK - draft only/);
    assert.match(portalHtml, /You can save this order as a draft, but it cannot be released yet/);
});
