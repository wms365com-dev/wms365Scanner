const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const portalSource = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const warehouseSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("inbound schema and status normalization include draft", () => {
    assert.match(serverSource, /portal_inbounds_status_check check \(status in \('DRAFT', 'SUBMITTED'/);
    assert.match(serverSource, /\["DRAFT", "SUBMITTED", "ARRIVED", "RECEIVED"/);
    assert.match(serverSource, /alter table company_fulfillment_locations add column if not exists customer_portal_visible boolean not null default true/);
});
test("customer inbound changes are account scoped", () => {
    const start = serverSource.indexOf('app.put("/api/portal/inbounds/:id"');
    const end = serverSource.indexOf('app.post("/api/portal/inbounds/:id/status"', start);
    assert.ok(start >= 0 && end > start);
    assert.match(serverSource.slice(start, end), /session\.access\.accountName/);
    assert.match(serverSource, /normalizeText\(current\.accountName\) !== normalizedAccount/);
});
test("unsafe inbound reopening is blocked", () => {
    assert.match(serverSource, /Only draft purchase orders can be edited/);
    assert.match(serverSource, /portal_inbound_receipt_allocations where inbound_id=\$1/);
    assert.match(serverSource, /pallet_status <> 'PLANNED'/);
    assert.match(serverSource, /Cancel the active delivery appointment before returning/);
});
test("submission requires date and receiving document", () => {
    assert.match(serverSource, /Choose tomorrow or a future arrival date before submitting/);
    assert.match(serverSource, /Attach at least one BOL or packing slip before submitting this inbound/);
});
test("both user surfaces expose correction actions", () => {
    assert.match(portalSource, /id="saveInboundDraftBtn"/);
    assert.match(portalSource, /data-return-inbound-draft/);
    assert.match(warehouseSource, /data-next-status="DRAFT"/);
    assert.match(warehouseSource, /inboundStatus !== "DRAFT"/);
});
