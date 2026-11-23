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

test("sales order Select items reports unavailable context and focuses a newly added line", () => {
    const block = functionBlock("selectWarehouseSalesOrderItem", "renderWarehouseSalesOrderContext");
    assert.match(block, /Choose an active company before selecting sales order items\./);
    assert.match(block, /No pickable inventory is available/);
    assert.match(block, /addWarehouseOrderLine\(\)/);
    assert.match(block, /scrollIntoView/);
    assert.match(block, /input\?\.focus\(\)/);
    assert.match(block, /Item line added\. Search by SKU, UPC, or description\./);
});

test("purchase order Select items reports unavailable context and focuses a newly added line", () => {
    const block = functionBlock("selectWarehouseInboundItem", "renderWarehouseInboundContext");
    assert.match(block, /Choose an active company before selecting purchase order items\./);
    assert.match(block, /No saved item masters were found/);
    assert.match(block, /addWarehouseInboundLine\(\)/);
    assert.match(block, /scrollIntoView/);
    assert.match(block, /select\?\.focus\(\)/);
    assert.match(block, /Item line added\. Choose a saved company item\./);
});

test("both command-bar Select items controls use the feedback handlers", () => {
    assert.match(ui, /salesOrderCommandAddLineBtn\?\.addEventListener\("click", selectWarehouseSalesOrderItem\)/);
    assert.match(ui, /purchaseOrderCommandAddLineBtn\?\.addEventListener\("click", selectWarehouseInboundItem\)/);
    assert.doesNotMatch(ui, /CommandAddLineBtn\?\.addEventListener\("click", \(\) => addWarehouse/);
});

test("item selection keeps company feature and scoped catalog guards", () => {
    const sales = functionBlock("selectWarehouseSalesOrderItem", "renderWarehouseSalesOrderContext");
    const purchase = functionBlock("selectWarehouseInboundItem", "renderWarehouseInboundContext");
    assert.match(sales, /companyHasFeature\(company, COMPANY_FEATURE_KEYS\.ORDER_ENTRY\)/);
    assert.match(sales, /getWarehouseSalesOrderSelectableItems\(\)/);
    assert.match(purchase, /companyHasFeature\(company, COMPANY_FEATURE_KEYS\.INBOUND_NOTICES\)/);
    assert.match(purchase, /getWarehouseInboundCatalogItemCount\(company\)/);
});
