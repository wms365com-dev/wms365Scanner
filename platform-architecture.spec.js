const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    sanitizePartnerApiScopes,
    normalizePartnerApiLimit,
    encodePartnerApiCursor,
    decodePartnerApiCursor,
    buildPartnerApiPage,
    makeWarehouseShipmentCode,
    buildWarehouseShipmentQuantityAllocator,
    buildInventoryCountVarianceFacts
} = require("./server.js");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const migrationSource = fs.readFileSync(
    path.join(__dirname, "migrations", "20260730_platform_shipments_and_partner_api.sql"),
    "utf8"
);
const checklistSource = fs.readFileSync(path.join(__dirname, "WMS365_PLATFORM_BUILD_CHECKLIST.md"), "utf8");

test("platform checklist covers every requested architecture area", () => {
    for (const heading of [
        "Versioned Partner API",
        "Customer Orders and Warehouse Shipments",
        "Inventory Transaction Service",
        "Asynchronous Bulk Jobs",
        "Billing Transactions",
        "Warehouse Tasks",
        "Cycle Counts and Variances",
        "OAuth and Scoped Integrations",
        "API Documentation and Changelog"
    ]) {
        assert.match(checklistSource, new RegExp(heading));
    }
});

test("warehouse shipments are separate from customer orders and scoped to a warehouse", () => {
    for (const source of [serverSource, migrationSource]) {
        assert.match(source, /create table if not exists warehouse_shipments/);
        assert.match(source, /order_id bigint not null references portal_orders/);
        assert.match(source, /fulfillment_location_id bigint not null references fulfillment_locations/);
        assert.match(source, /unique \(order_id, fulfillment_location_id\)/);
        assert.match(source, /create table if not exists warehouse_shipment_lines/);
        assert.match(source, /order_line_id bigint not null references portal_order_lines/);
    }
});

test("release and status transitions synchronize warehouse shipments", () => {
    assert.match(serverSource, /async function syncWarehouseShipmentsForOrder/);
    assert.match(serverSource, /syncWarehouseShipmentsForOrder\(client, releasedOrder, \{ status: "RELEASED" \}\)/);
    assert.match(serverSource, /syncWarehouseShipmentsForOrder\(client, updatedOrder, \{ status: nextStatus \}\)/);
    assert.match(serverSource, /syncWarehouseShipmentsForOrder\(client, shippedOrder, \{ status: "SHIPPED" \}\)/);
    assert.match(serverSource, /syncWarehouseShipmentsForOrder\(client, cancelledOrder, \{ status: "CANCELLED" \}\)/);
});

test("warehouse shipment closeout is shipment-specific and tenant scoped", () => {
    assert.match(serverSource, /async function updateWarehouseShipmentDetail/);
    assert.match(serverSource, /tracking_reference=\$5, bol_reference=\$6/);
    assert.match(serverSource, /portal_order_documents set warehouse_shipment_id = \$1/);
    assert.match(serverSource, /Confirm the shipped quantity for every warehouse shipment line/);
    assert.match(serverSource, /Enter the parcel tracking number/);
    assert.match(serverSource, /SHIPMENT_PACKING_SLIP/);
    assert.match(serverSource, /SHIPMENT_LOAD_PHOTO/);
    assert.match(serverSource, /app\.patch\("\/api\/v1\/shipments\/:id", requirePartnerApiScope\("shipments:write"\)/);
    assert.match(serverSource, /accountName: req\.partnerApi\.accountName/);
});

test("existing non-draft orders are backfilled into warehouse shipments", () => {
    assert.match(serverSource, /async function backfillWarehouseShipments/);
    assert.match(serverSource, /not exists \(select 1 from warehouse_shipments s where s\.order_id = o\.id\)/);
    assert.match(serverSource, /void backfillWarehouseShipments\(\)/);
});

test("customer shipment emails summarize each warehouse shipment and shortage", () => {
    assert.match(serverSource, /order\.warehouseShipments =/);
    assert.match(serverSource, /Warehouse Shipments:/);
    assert.match(serverSource, /warehouseShipmentList/);
    assert.match(serverSource, /SHORT \$\{shortage\}/);
});

test("platform migration includes jobs, scoped clients, tokens, idempotency, and audit", () => {
    for (const table of [
        "async_jobs",
        "async_job_rows",
        "partner_api_clients",
        "partner_api_tokens",
        "partner_api_idempotency",
        "partner_api_audit_log"
    ]) {
        assert.match(migrationSource, new RegExp(`create table if not exists ${table}`));
        assert.match(serverSource, new RegExp(`create table if not exists ${table}`));
    }
});

test("partner API scopes reject unknown permissions", () => {
    assert.deepEqual(
        sanitizePartnerApiScopes(["inventory:read", "orders:write", "admin:all", "inventory:read"]),
        ["inventory:read", "orders:write"]
    );
});

test("partner API pagination is bounded and cursors round trip", () => {
    assert.equal(normalizePartnerApiLimit(0), 1);
    assert.equal(normalizePartnerApiLimit(9999), 200);
    const cursor = encodePartnerApiCursor(482);
    assert.equal(decodePartnerApiCursor(cursor), 482);
    assert.throws(() => decodePartnerApiCursor("not-a-cursor"), /pagination cursor is invalid/i);
});

test("partner API page envelope includes data metadata and next link", () => {
    const page = buildPartnerApiPage(
        [{ id: 10, value: "A" }, { id: 11, value: "B" }],
        1,
        (row) => ({ id: String(row.id), value: row.value }),
        {
            protocol: "https",
            path: "/api/v1/orders",
            query: { limit: "1" },
            get: () => "app.wms365.co"
        }
    );
    assert.deepEqual(page.data, [{ id: "10", value: "A" }]);
    assert.equal(page.meta.hasMore, true);
    assert.equal(page.meta.nextCursor, encodePartnerApiCursor(10));
    assert.match(page.links.next, /\/api\/v1\/orders\?/);
});

test("warehouse shipment codes are stable per order and warehouse", () => {
    assert.equal(
        makeWarehouseShipmentCode({ orderCode: "ORD-000471" }, 2),
        "SHP-ORD-000471-2"
    );
});

test("actual shipped quantity is distributed across split warehouse allocations", () => {
    const allocator = buildWarehouseShipmentQuantityAllocator({
        shipmentLines: [{ orderLineId: "71", shippedQuantity: 7 }]
    });
    assert.equal(allocator.allocate("71", 5), 5);
    assert.equal(allocator.allocate("71", 5), 2);
    assert.equal(allocator.allocate("71", 5), 0);
});

test("shipment quantities default to allocated quantity when no confirmation exists", () => {
    const allocator = buildWarehouseShipmentQuantityAllocator({});
    assert.equal(allocator.allocate("71", 5), 5);
});

test("versioned API routes are read scoped and customer bound", () => {
    assert.match(serverSource, /app\.get\("\/api\/v1\/inventory", requirePartnerApiScope\("inventory:read"\)/);
    assert.match(serverSource, /app\.get\("\/api\/v1\/orders", requirePartnerApiScope\("orders:read"\)/);
    assert.match(serverSource, /app\.get\("\/api\/v1\/shipments", requirePartnerApiScope\("shipments:read"\)/);
    assert.match(serverSource, /where i\.account_name = \$1/);
    assert.match(serverSource, /where o\.account_name = \$1/);
    assert.match(serverSource, /where s\.account_name = \$1/);
});

test("partner writes require idempotency and preserve the original response", () => {
    assert.match(serverSource, /Provide an Idempotency-Key header for this write request/);
    assert.match(serverSource, /unique \(client_id, idempotency_key\)/);
    assert.match(serverSource, /row\.response_status && row\.response_body/);
    assert.match(serverSource, /This Idempotency-Key was already used for a different request/);
});

test("async imports use atomic claims, stale recovery, retries, and row results", () => {
    assert.match(serverSource, /async function processAsyncJobById/);
    assert.match(serverSource, /status = 'RUNNING' and claimed_at < now\(\) - interval '30 minutes'/);
    assert.match(serverSource, /attempts < max_attempts/);
    assert.match(serverSource, /COMPLETED_WITH_WARNINGS/);
    assert.match(serverSource, /async_job_rows/);
    assert.match(serverSource, /errors\.csv/);
});

test("test API credentials are blocked from production", () => {
    assert.match(serverSource, /Test credentials cannot access the production API/);
});

test("token issuance and refresh are written to the partner API audit log", () => {
    assert.match(serverSource, /auditPartnerApiTokenEvent\(client, result\.rows\[0\], "TOKEN_REFRESH"\)/);
    assert.match(serverSource, /auditPartnerApiTokenEvent\(client, clientRow, "TOKEN_ISSUE"\)/);
});

test("cycle counts classify variance and require approval before posting", () => {
    assert.deepEqual(buildInventoryCountVarianceFacts(100, 100), {
        varianceQuantity: 0,
        variancePercent: 0,
        varianceSeverity: "NONE",
        approvalRequired: true
    });
    assert.equal(buildInventoryCountVarianceFacts(100, 98).varianceSeverity, "LOW");
    assert.equal(buildInventoryCountVarianceFacts(100, 95).varianceSeverity, "MEDIUM");
    assert.equal(buildInventoryCountVarianceFacts(100, 80).varianceSeverity, "HIGH");
    assert.match(serverSource, /must be reviewed and approved before it can change available stock/);
});

test("warehouse task history is append-only in boot schema and migration", () => {
    const controlsMigration = fs.readFileSync(
        path.join(__dirname, "migrations", "20260731_operational_controls.sql"),
        "utf8"
    );
    for (const source of [serverSource, controlsMigration]) {
        assert.match(source, /create table if not exists warehouse_task_history/);
        assert.match(source, /record_warehouse_task_history/);
        assert.match(source, /Warehouse task history is append-only/);
    }
});

test("approved billing facts are locked and all billing changes are audited", () => {
    const controlsMigration = fs.readFileSync(
        path.join(__dirname, "migrations", "20260731_operational_controls.sql"),
        "utf8"
    );
    for (const source of [serverSource, controlsMigration]) {
        assert.match(source, /create table if not exists billing_event_audit/);
        assert.match(source, /Approved billing source facts are locked/);
        assert.match(source, /Billing events must be voided or credited, not deleted/);
        assert.match(source, /Billing event audit is append-only/);
    }
});

test("authorized warehouse users can read a task's immutable history", () => {
    assert.match(serverSource, /app\.get\("\/api\/admin\/warehouse-tasks\/:id\/history"/);
    assert.match(serverSource, /assertAppUserCompanyAccess\(client, req\.appUser, task\.account_name\)/);
    assert.match(serverSource, /from warehouse_task_history[\s\S]*where task_id = \$1/);
});

test("OpenAPI and changelog cover the live v1 routes", () => {
    const openApi = fs.readFileSync(path.join(__dirname, "docs", "wms365-partner-api-v1.yaml"), "utf8");
    const changelog = fs.readFileSync(path.join(__dirname, "docs", "WMS365_API_CHANGELOG.md"), "utf8");
    for (const route of ["/oauth/token:", "/inventory:", "/orders:", "/shipments:", "/jobs:"]) {
        assert.match(openApi, new RegExp(route.replace("/", "\\/")));
    }
    assert.match(openApi, /Idempotency-Key/);
    assert.match(changelog, /v1 Initial Foundation/);
    assert.match(serverSource, /app\.get\("\/api\/v1\/openapi\.yaml"/);
    assert.match(serverSource, /app\.get\("\/api\/v1\/changelog"/);
});
