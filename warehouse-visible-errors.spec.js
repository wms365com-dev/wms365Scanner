const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse document errors are visible without scrolling to the bottom of the form", () => {
    assert.match(source, /id="warehouseViewportAlert" hidden/);
    assert.match(source, /role="alert" aria-live="assertive"/);
    assert.match(source, /\.warehouse-viewport-alert\s*\{[\s\S]*?position:\s*fixed;/);
    assert.match(source, /\.status\.error\s*\{[\s\S]*?color:\s*#7a271a;/);
    assert.match(source, /if \(isDocumentError\) showWarehouseViewportAlert\(text, element\);/);

    const inlineMessageIndex = source.indexOf('id="warehouseOrderMessage"');
    const orderButtonRowIndex = source.indexOf('<div class="button-row" style="margin-top: 1rem;">', inlineMessageIndex);
    assert.ok(inlineMessageIndex > 0 && orderButtonRowIndex > inlineMessageIndex, "inline order error should appear before the action buttons");
});

test("warehouse pallet errors point the user to the affected pick-bin field", () => {
    assert.match(source, /String\(text \|\| ""\)\.match\(\/\\bpallet\\s\+\(\\d\+\)\\b\/i\)/);
    assert.match(source, /warehouseViewportAlertTarget\.setAttribute\("aria-invalid", "true"\)/);
    assert.match(source, /id="warehouseViewportAlertReview"[^>]*>Review field<\/button>/);
    assert.match(source, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
});
