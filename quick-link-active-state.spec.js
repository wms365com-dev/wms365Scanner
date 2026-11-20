const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("WMS-07 derives quick-link state from the rendered section", () => {
    assert.match(source, /function syncDesktopQuickLinkState\(section = activeSection\)/);
    assert.match(source, /syncDesktopQuickLinkState\(section\);\s*syncScanSectionUi\(\);/);
    assert.match(source, /button\.setAttribute\("aria-current", "page"\)/);
    assert.match(source, /button\.removeAttribute\("aria-current"\)/);
    assert.match(source, /\.desktop-embeddingbar button\[aria-current="page"\]/);
});

test("WMS-07 distinguishes focused master lists from generic inventory", () => {
    assert.match(source, /normalizedSection !== "inventory" \|\| \(!!focusedMasterType && buttonMasterType === focusedMasterType\)/);
    assert.match(source, /data-jump-section="inventory"[^>]+data-master-list="CUSTOMER"[^>]*>Customers</);
    assert.match(source, /data-jump-section="inventory"[^>]+data-master-list="VENDOR"[^>]*>Vendors</);
    assert.match(source, /data-jump-section="inventory"[^>]+data-master-list="ITEM"[^>]*>Items</);
});

test("WMS-07 leaves pages without a matching quick link unhighlighted", () => {
    const quickBar = source.match(/<div class="desktop-embeddingbar desktop-only"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(quickBar, "desktop quick-link container should exist");
    assert.doesNotMatch(quickBar[1], /data-jump-section="integrations"/);
    assert.doesNotMatch(source, /(?:mouseenter|mouseover|pointerenter)[\s\S]{0,300}aria-current/);
});

test("warehouse scripts remain valid after quick-link synchronization", () => {
    const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0);
    scripts.forEach((match) => new vm.Script(match[1]));
});
