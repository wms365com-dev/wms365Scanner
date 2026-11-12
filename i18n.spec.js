const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("wms365-i18n.js", "utf8");
const portal = fs.readFileSync("portal.html", "utf8");
const warehouse = fs.readFileSync("index.html", "utf8");

test("customer and warehouse sites load the shared localization layer", () => {
    assert.match(portal, /<script src="\/wms365-i18n\.js"><\/script>/);
    assert.match(warehouse, /<script src="\/wms365-i18n\.js"><\/script>/);
});

test("localization supports persistent English, French, and Spanish selection", () => {
    assert.match(source, /SUPPORTED = \["en", "fr", "es"\]/);
    assert.match(source, /localStorage\.setItem\(STORAGE_KEY, currentLanguage\)/);
    assert.match(source, /document\.documentElement\.lang = currentLanguage/);
    assert.match(source, /MutationObserver/);
});

test("French and Spanish dictionaries cover sign-in and core order workflows", () => {
    for (const requiredText of [
        "Customer Login",
        "Inventory",
        "Sales Orders",
        "Purchase Orders",
        "Save Draft",
        "Release Order",
        "Requested Ship Date",
        "Tracking Number"
    ]) {
        const occurrences = source.split(`"${requiredText}"`).length - 1;
        assert.ok(occurrences >= 2, `${requiredText} should be present in both translation dictionaries`);
    }
});
