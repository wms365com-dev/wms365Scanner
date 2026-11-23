const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const server = fs.readFileSync("server.js", "utf8");
const html = fs.readFileSync("mobile-ship-pdf.html", "utf8");

test("PDF shipment tool is authenticated and uses the normal mobile shipment endpoint", () => {
    assert.match(server, /app\.get\(\["\/mobile\/ship-pdf"[\s\S]*?sendAuthenticatedWarehouseModule\(req, res, "mobile-ship-pdf\.html", "\/mobile\/ship-pdf"\)/);
    assert.match(html, /\/api\/mobile\/pick-orders\?accountName=/);
    assert.match(html, /\/api\/admin\/portal-orders\/\$\{state\.order\.id\}\/status/);
    assert.match(html, /status:'SHIPPED'/);
    assert.match(html, /SHIPMENT_BOL','SHIPMENT_PACKING_SLIP','SHIPMENT_LOAD_PHOTO/);
    assert.match(html, /packingSlipQuantityConfirmed:true/);
    assert.match(html, /Tesseract\.createWorker/);
    assert.doesNotMatch(html, /openai|anthropic|gemini/i);
});
