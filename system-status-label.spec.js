const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse header visibly names system status beside the status dot", () => {
    assert.match(source, /id="appBuildBadge"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(source, /id="appConnectionDot"[^>]*aria-label="Checking connection"/);
    assert.match(source, /id="appConnectionLabel">Checking<\/span>/);
    assert.match(source, /connected:\s*"System online"/);
    assert.match(source, /disconnected:\s*"Connection issue"/);
    assert.match(source, /checking:\s*"Checking system"/);
});

test("connection refresh updates both the visible label and accessible detail", () => {
    assert.match(source, /appConnectionLabel:\s*document\.getElementById\("appConnectionLabel"\)/);
    assert.match(source, /ui\.appConnectionLabel\.textContent\s*=\s*labels\[normalized\]/);
    assert.match(source, /ui\.appConnectionLabel\.title\s*=\s*message/);
    assert.match(source, /ui\.appConnectionDot\.setAttribute\("aria-label", message\)/);
    assert.match(source, /healthy\s*\?\s*"connected"\s*:\s*"disconnected"/);
});

test("status label is informational and does not alter tenant, warehouse, or transaction behavior", () => {
    assert.doesNotMatch(source, /appConnectionLabel[^\n]*(accountName|fulfillmentLocation|order|inbound|inventory)/i);
    assert.doesNotMatch(source, /appConnectionLabel[^\n]*(fetch\(|requestJson\(|addEventListener)/);
});
