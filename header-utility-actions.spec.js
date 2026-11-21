const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const utilityStart = html.indexOf('<div class="desktop-utility-actions">');
const utilityEnd = html.indexOf('<div class="company-switcher-popout hidden"', utilityStart);
const utilityBlock = utilityStart >= 0 && utilityEnd > utilityStart ? html.slice(utilityStart, utilityEnd) : "";

test("header does not render inert Find, Notifications, or Help utilities", () => {
    assert.ok(utilityBlock, "desktop utility header should remain discoverable");
    assert.doesNotMatch(utilityBlock, /<span class="topbar-icon">(?:Find|Notifications|Help)<\/span>/);
});

test("remaining header utilities use real interactive elements", () => {
    assert.match(utilityBlock, /<a class="utility-action-link" href="mailto:support@wms365\.co">Contact Support<\/a>/);
    assert.match(utilityBlock, /<summary class="topbar-icon-button"[^>]*id="desktopCompanySwitcherSummary"/);
    assert.match(utilityBlock, /<summary class="topbar-icon" title="Account settings">Settings<\/summary>/);
});

test("the real page Find command remains available", () => {
    assert.match(html, /<button class="desktop-ribbon-icon" id="desktopCommandFindBtn"[^>]*>Find<\/button>/);
});
