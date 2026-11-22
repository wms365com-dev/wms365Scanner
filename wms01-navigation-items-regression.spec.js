const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse navigation scripts remain valid JavaScript", () => {
    const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0);
    scripts.forEach((match) => new vm.Script(match[1]));
});

test("WMS-01 defers the master library while another module is active", () => {
    assert.match(source, /if \(activeSection === "inventory"\) renderMasterLibrary\(\);/);
    assert.match(source, /if \(section === "inventory"\) \{\s*renderMasterLibrary\(\);\s*if \(!focusAnchorId\) \{\s*hydrateActiveCompanyProfileForEdit\(\)\.catch/);
    assert.doesNotMatch(source, /renderDatalists\(\);\s*renderMasterLibrary\(\);/);
});

test("WMS-01 bounds both item render surfaces", () => {
    assert.match(source, /const MASTER_ITEM_PREVIEW_LIMIT = 50;/);
    assert.match(source, /const MASTER_ITEM_FOCUSED_LIMIT = 200;/);
    assert.match(source, /const visibleItems = itemMatches\.slice\(0, MASTER_ITEM_PREVIEW_LIMIT\);/);
    assert.match(source, /const visibleItems = itemMatches\.slice\(0, MASTER_ITEM_FOCUSED_LIMIT\);/);
    assert.match(source, /renderMasterItemRows\(visibleItems, itemMatches\.length, query\)/);
});

test("bounded item rendering keeps the total-match narrowing message", () => {
    assert.match(source, /if \(items\.length < totalMatches\)/);
    assert.match(source, /Showing the first \$\{num\(items\.length\)\} of \$\{num\(totalMatches\)\} items\. Narrow the filter to see more\./);
});
