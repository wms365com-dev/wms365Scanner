"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const verifier = fs.readFileSync(path.join(__dirname, "scripts", "verify-test-company-draft-archive.js"), "utf8");

function functionBody(source, name, nextName) {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf(nextName, start);
    assert.ok(start >= 0 && end > start, `${name} must be present`);
    return source.slice(start, end);
}

test("warehouse sales orders expose a distinct draft archive action on both action rows", () => {
    assert.match(desktop, /id="salesOrderCommandArchiveBtn"[^>]*>Archive Draft</);
    assert.match(desktop, /id="archiveWarehouseOrderBtn"[^>]*>Archive Draft</);
    assert.match(desktop, /archiveWarehouseOrderBtn\?\.addEventListener\("click", archiveWarehouseSalesOrderDraft\)/);
    assert.match(desktop, /salesOrderCommandArchiveBtn\?\.addEventListener\("click", archiveWarehouseSalesOrderDraft\)/);
    assert.match(desktop, /const canArchiveDraft = !!order\?\.id && order\.status === "DRAFT"/);
});

test("draft archive confirms intent and opens the stable order id without saving or cancellation", () => {
    const handler = functionBody(desktop, "archiveWarehouseSalesOrderDraft", "function getWarehouseInboundCompany");
    assert.match(handler, /const orderId = String\(editingWarehouseOrderId\)/);
    assert.match(handler, /currentOrder\.status !== "DRAFT"/);
    assert.match(handler, /window\.confirm\(`Archive draft order/);
    assert.match(handler, /requestJson\(`\/api\/admin\/portal-orders\/\$\{orderId\}\/archive`, \{ method: "POST" \}\)/);
    assert.match(handler, /response\.order\.status !== "ARCHIVED"/);
    assert.doesNotMatch(handler, /saveWarehouseSalesOrderDraft|status:\s*"CANCELLED"/);
});

test("server archive remains draft-only, audited, allocation-safe, and inventory-neutral", () => {
    const start = server.indexOf("async function archivePortalOrderForAccount");
    const end = server.indexOf("async function archivePortalOrder(", start);
    const archive = start >= 0 && end > start ? server.slice(start, end) : "";
    assert.match(archive, /if \(order\.status === "ARCHIVED"\)/);
    assert.match(archive, /if \(order\.status !== "DRAFT"\)/);
    assert.match(archive, /recordPortalOrderAllocationTransactions/);
    assert.match(archive, /delete from portal_order_allocations/);
    assert.match(archive, /status = 'ARCHIVED'/);
    assert.match(archive, /archived_at = coalesce\(archived_at, now\(\)\)/);
    assert.match(archive, /insertActivity/);
    assert.match(archive, /syncWarehouseTasksForOrder/);
    assert.doesNotMatch(archive, /delete from portal_order_lines|inventory_lines|setInventoryQuantity/);
});

test("warehouse archive route composes central order scope with company and feature authorization", () => {
    const guard = server.indexOf('app.use("/api/admin/portal-orders/:id"');
    const route = server.indexOf('app.post("/api/admin/portal-orders/:id/archive"');
    const end = server.indexOf('app.post("/api/admin/portal-inbounds"', route);
    const body = route >= 0 && end > route ? server.slice(route, end) : "";
    assert.ok(guard >= 0 && guard < route, "central order guard must precede archive route");
    assert.match(body, /getPortalOrderAccountNameById/);
    assert.match(body, /assertAppUserCompanyAccess/);
    assert.match(body, /assertCompanyFeatureEnabled/);
    assert.match(body, /withTransaction/);
});

test("sandbox archive verifier is pinned, isolated, negative-scoped, and cleanup-safe", () => {
    assert.match(verifier, /requireSandboxConfiguration\(env\)/);
    assert.match(verifier, /requireDesignatedTestCompany\(pool\)/);
    assert.match(verifier, /designatedCompanyId: TEST_COMPANY\.id/);
    assert.match(verifier, /originalFeatureFlags/);
    assert.match(verifier, /ORDER_ENTRY: true/);
    assert.match(verifier, /feature_flags=\$2::jsonb/);
    assert.match(verifier, /denied\.status !== 403/);
    assert.match(verifier, /released\.status !== 400/);
    assert.match(verifier, /Draft archive fixture cleanup left sandbox residue/);
    assert.doesNotMatch(verifier, /delete from inventory_transactions/);
    assert.doesNotMatch(verifier, /sendEmail|Shopify|carrier|billing/);
});
