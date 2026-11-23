const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function functionBlock(name, nextName) {
    const start = ui.indexOf(`function ${name}`);
    const end = ui.indexOf(`function ${nextName}`, start);
    assert.ok(start >= 0 && end > start, `${name} function block must exist`);
    return ui.slice(start, end);
}

test("list pills and document status chips share one compact visual treatment", () => {
    assert.match(ui, /\.pill,\s*\.erp-status-chip\s*\{/);
    assert.match(ui, /border-radius: 999px/);
    assert.match(ui, /\.erp-status-chip\.success/);
    assert.match(ui, /\.erp-status-chip\.info/);
    assert.match(ui, /\.erp-status-chip\.error/);
    assert.match(ui, /\.erp-status-chip\.neutral/);
});

test("sales order tones distinguish workflow progress without changing status values", () => {
    const block = functionBlock("portalOrderStatusTone", "applyStatusPillTone");
    assert.match(block, /CANCELLED.*error/);
    assert.match(block, /DRAFT.*warn/);
    assert.match(block, /SHIPPED.*success/);
    assert.match(block, /ARCHIVED.*neutral/);
    assert.match(block, /return "info"/);
});

test("document headers apply the same scoped status tone helpers", () => {
    const sales = functionBlock("resetWarehouseSalesOrderForm", "onWarehouseOrderLinesClick");
    const purchase = functionBlock("resetWarehouseInboundForm", "onWarehouseInboundLinesClick");
    assert.match(sales, /applyStatusPillTone\(ui\.warehouseOrderStatusChip, portalOrderStatusTone/);
    assert.match(purchase, /applyStatusPillTone\(ui\.warehouseInboundStatusChip, inboundStatusPillClass/);
});

test("tone application removes stale classes before adding an allowlisted tone", () => {
    const block = functionBlock("applyStatusPillTone", "formatPortalOrderStatus");
    assert.match(block, /classList\.remove\("neutral", "info", "success", "warn", "warning", "error"\)/);
    assert.match(block, /classList\.add/);
    assert.doesNotMatch(block, /innerHTML/);
});
