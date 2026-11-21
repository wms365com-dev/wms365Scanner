const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function contrastRatio(foreground, background) {
    const luminance = (hex) => {
        const channels = hex.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16) / 255);
        const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
}

test("inventory search modes expose selected tab semantics", () => {
    assert.match(source, /id="searchBySkuBtn"[^>]*role="tab"[^>]*aria-selected="true"/);
    assert.match(source, /id="searchByLocationBtn"[^>]*role="tab"[^>]*aria-selected="false"/);
    assert.match(source, /searchBySkuBtn\.setAttribute\("aria-selected", String\(mode === "sku"\)\)/);
    assert.match(source, /searchByLocationBtn\.setAttribute\("aria-selected", String\(mode === "location"\)\)/);
});

test("inactive and selected search modes meet normal-text contrast", () => {
    assert.ok(contrastRatio("3f5f76", "ffffff") >= 4.5, "inactive mode must meet WCAG AA contrast");
    assert.ok(contrastRatio("ffffff", "3f5f76") >= 4.5, "selected mode must meet WCAG AA contrast");
    assert.match(source, /\.segmented button \{[\s\S]*?background: #ffffff;[\s\S]*?color: var\(--brand-2\);/);
    assert.match(source, /\.segmented button\.active \{[\s\S]*?background: var\(--brand-2\);[\s\S]*?color: #ffffff;/);
    assert.match(source, /\.segmented button:disabled \{[\s\S]*?cursor: not-allowed;/);
    assert.match(source, /\.segmented button:focus-visible \{[\s\S]*?outline:/);
});

test("location mode remains company scoped and searches location only", () => {
    assert.match(source, /searchByLocationBtn\.addEventListener\("click", \(\) => setSearchMode\("location"\)\)/);
    assert.match(source, /const ownerFilter = getScopedCompanyValue\(ui\.searchAccount\.value\);/);
    assert.match(source, /const matches = getScopedInventory\(ownerFilter\)\.filter\(\(line\) => searchMode === "sku"[\s\S]*?: line\.location\.includes\(query\)/);
    assert.match(source, /function getScopedInventory\(ownerFilter = ""\) \{\s*return filterInventoryByOwner\(getScopedCompanyValue\(ownerFilter\)\);\s*\}/);
});
