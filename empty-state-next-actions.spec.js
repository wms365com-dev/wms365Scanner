const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("empty purchase orders explain the state and offer a company-scoped next action", () => {
    assert.match(source, /No purchase orders exist for this company yet\./);
    assert.match(source, /data-empty-inbound-action="new">New Purchase Order/);
    assert.match(source, /const emptyAction = event\.target\.closest\("\[data-empty-inbound-action\]"\)[\s\S]*showPurchaseOrderDocument\(null, \{ scroll: true \}\)/);
    assert.match(source, /ui\.portalInboundsList\.innerHTML = company\s*\?/);
});

test("empty and filtered sales orders offer an effective next action", () => {
    assert.match(source, /No sales orders exist for this company yet\./);
    assert.match(source, /data-empty-order-action="new">New Sales Order/);
    assert.match(source, /data-empty-order-action="clear-filters">Clear Filters/);
    assert.match(source, /data-empty-order-action="view-open">View Sales Orders/);
    assert.match(source, /if \(action === "new"\)[\s\S]*openNewSalesOrderDocument\(\{ scroll: true \}\)/);
    assert.match(source, /ui\.portalOrdersList\.innerHTML = company\s*\?/);
});

test("items are described and counted as product master data", () => {
    assert.match(source, /id="masterItemCount">0 items</);
    assert.match(source, /Items are product master data used by receiving and orders\./);
    assert.match(source, /\$\{num\(itemMatches\.length\)\} item\$\{itemMatches\.length === 1 \? "" : "s"\}/);
    assert.match(source, /data-empty-item-action="\$\{query \? "clear" : "new"\}"/);
    assert.match(source, /showMasterItemCard\(null, \{ scroll: true \}\)/);
    assert.doesNotMatch(source, /id="masterItemCount">0 saved/);
});

test("an unchanged empty sales-order refresh clears stale success feedback", () => {
    assert.match(source, /setPortalOrdersLoadingMessage\(orders\.length\s*\?/);
    assert.match(source, /: "", "success"\)/);
    assert.match(source, /if \(!message\) \{[\s\S]*ui\.portalOrdersMessage\.className = "status"/);
});

test("empty-state controls do not bypass authenticated server mutation routes", () => {
    assert.match(serverSource, /app\.post\("\/api\/portal\/inbounds"/);
    assert.match(serverSource, /app\.post\("\/api\/portal\/orders"/);
    assert.match(serverSource, /app\.post\("\/api\/portal\/inbounds"[\s\S]*?requirePortalSession\(req\)[\s\S]*?assertPortalAccountAccess/);
    assert.match(serverSource, /app\.post\("\/api\/portal\/orders"[\s\S]*?requirePortalSession\(req\)[\s\S]*?assertPortalAccountAccess/);
    assert.match(serverSource, /app\.post\("\/api\/portal\/items"[\s\S]*?requirePortalSession\(req\)[\s\S]*?assertPortalAccountAccess/);
    assert.doesNotMatch(source, /data-empty-(?:item|inbound|order)-action[^\n]*(?:requestJson|fetch)\(/);
});
