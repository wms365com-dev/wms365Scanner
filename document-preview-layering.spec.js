const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const read = (fileName) => fs.readFileSync(path.join(__dirname, fileName), "utf8");

test("warehouse document preview stays above warehouse popouts", () => {
    const html = read("index.html");
    const previewLayer = html.match(/#warehouseDocumentPreviewModal\s*\{[^}]*z-index:\s*(\d+)/s);
    const orderLayer = html.match(/#warehouseOrderEntryCard,[\s\S]*?z-index:\s*(\d+)/);

    assert.ok(previewLayer, "warehouse preview layer is explicitly defined");
    assert.ok(orderLayer, "warehouse order popout layer is defined");
    assert.ok(Number(previewLayer[1]) > Number(orderLayer[1]), "preview must be above the order popout");
    assert.match(html, /id="warehouseDocumentDownloadLink"[^>]*target="_blank"[^>]*>Open in new tab<\/a>/);
});

test("customer portal preview has an external-view fallback", () => {
    const html = read("portal.html");

    assert.match(html, /#documentPreviewModal\s*\{[^}]*z-index:\s*4100/s);
    assert.match(html, /id="documentPreviewOpenLink"[^>]*target="_blank"[^>]*>Open in new tab<\/a>/);
    assert.match(html, /documentPreviewOpenLink:\s*document\.getElementById\("documentPreviewOpenLink"\)/);
    assert.match(html, /ui\.documentPreviewOpenLink\.href = documentUrl/);
    assert.match(html, /ui\.documentPreviewOpenLink\.href = "#"/);
});
