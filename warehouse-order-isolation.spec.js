const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    getAccessibleFulfillmentLocationIdsForAppUser,
    assertAppUserPortalOrderWarehouseAccess,
    scopePortalOrderToFulfillmentLocationIds,
    getPortalOrderReleaseRecipients,
    buildUserFacingError,
    buildAccessRestrictionAuditEntry
} = require("./server");

test("explicit warehouse assignments do not inherit every warehouse used by the company", async () => {
    const client = { query: async () => { throw new Error("database fallback must not run"); } };
    const ids = await getAccessibleFulfillmentLocationIdsForAppUser(client, {
        id: 10,
        role: "warehouse_customer_service",
        assigned_fulfillment_locations: [{ id: "2", code: "WHS01" }],
        assigned_companies: ["PURE FOODS BY ESTEE"]
    });
    assert.deepEqual(ids, [2]);
});

test("Edwards-only user is denied a Courtney Park order even when the company is shared", async () => {
    const client = {
        query: async (sql) => {
            if (/from \(\s*select ws\.fulfillment_location_id/i.test(sql)) {
                return { rows: [{ fulfillment_location_id: "1" }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    };
    await assert.rejects(
        () => assertAppUserPortalOrderWarehouseAccess(client, {
            id: 10,
            role: "warehouse_customer_service",
            assigned_fulfillment_locations: [{ id: "2", code: "WHS01" }]
        }, 573),
        (error) => error.statusCode === 403
            && error.code === "ACCESS_RESTRICTED"
            && /^Access restricted\./i.test(error.message)
            && /another warehouse/i.test(error.message)
    );
});

test("split order payload is limited to the warehouse assigned to the user", () => {
    const order = {
        id: "900",
        orderCode: "ORD-TEST-SPLIT",
        accountName: "CODEX UX TEST 202605112319",
        fulfillmentLocationId: "1",
        fulfillmentLocationCode: "GW3PL-MISS",
        lines: [{
            id: "91",
            lineNumber: 1,
            sku: "TEST-SKU",
            quantity: 10,
            trackingLevel: "CASE",
            pickLocations: [
                { location: "MAIN-A01", quantity: 6, fulfillmentLocationId: "1", fulfillmentLocationCode: "GW3PL-MISS" },
                { location: "WHS01-A01", quantity: 4, fulfillmentLocationId: "2", fulfillmentLocationCode: "WHS01" }
            ]
        }]
    };
    const scoped = scopePortalOrderToFulfillmentLocationIds(order, [2]);
    assert.equal(scoped.lines.length, 1);
    assert.equal(scoped.lines[0].quantity, 4);
    assert.equal(scoped.lines[0].pickLocations.length, 1);
    assert.equal(scoped.lines[0].pickLocations[0].location, "WHS01-A01");
    assert.equal(String(scoped.fulfillmentLocationId), "2");
});

test("release email recipients are selected by the order warehouse", async () => {
    const client = {
        query: async (sql) => {
            if (/from app_users u/i.test(sql)) {
                return { rows: [
                    { email: "main@example.com", direct_company_access: true, assigned_fulfillment_location_ids: [1] },
                    { email: "edwards@example.com", direct_company_access: true, assigned_fulfillment_location_ids: [2] },
                    { email: "manager@example.com", direct_company_access: true, assigned_fulfillment_location_ids: [] }
                ] };
            }
            if (/from company_fulfillment_locations cfl/i.test(sql)) {
                return { rows: [
                    { fulfillment_location_id: 1, contact_email: "main-contact@example.com", is_primary: true },
                    { fulfillment_location_id: 2, contact_email: "edwards-contact@example.com", is_primary: false }
                ] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    };
    const recipients = await getPortalOrderReleaseRecipients(client, "CODEX UX TEST 202605112319", {
        fulfillmentLocationIds: [1]
    });
    assert.deepEqual(recipients.sort(), ["main-contact@example.com", "main@example.com", "manager@example.com"]);
    assert.equal(recipients.includes("edwards@example.com"), false);
    assert.equal(recipients.includes("edwards-contact@example.com"), false);
});

test("admin order and document routes enforce warehouse isolation before access or printing", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(source, /app\.use\("\/api\/admin\/portal-orders\/:id"[\s\S]*assertAppUserPortalOrderWarehouseAccess/);
    assert.match(source, /batch-pick-tickets\.pdf[\s\S]*assertAppUserPortalOrderWarehouseAccess/);
    assert.match(source, /portal-order-documents\/:id[\s\S]*assertAppUserPortalOrderWarehouseAccess/);
    assert.match(source, /filterPortalOrdersForAppUserWarehouses\(pool, companyScopedOrders, req\.appUser\)/);
});

test("restricted warehouse access uses plain language without exposing a technical status", () => {
    const response = buildUserFacingError({
        statusCode: 403,
        code: "ACCESS_RESTRICTED",
        message: "Access restricted. This sales order is assigned to another warehouse and is not available to your login."
    }, { path: "/api/admin/portal-orders/573" }, 403);
    assert.match(response.message, /^Access restricted\./);
    assert.doesNotMatch(response.message, /\b403\b/);
});

test("restricted attempts capture reviewable user, route, order, and warehouse context", () => {
    const entry = buildAccessRestrictionAuditEntry({
        message: "Access restricted.",
        accessRestriction: {
            resourceType: "PORTAL_ORDER",
            resourceId: "573",
            assignedFulfillmentLocationIds: [2],
            resourceFulfillmentLocationIds: [1]
        }
    }, {
        method: "GET",
        path: "/api/admin/portal-orders/573",
        appUser: {
            id: 10,
            email: "warehouse@example.com",
            full_name: "Warehouse User",
            role: "warehouse_customer_service"
        },
        params: { id: "573" }
    }, "request-123");
    assert.equal(entry.userEmail, "warehouse@example.com");
    assert.equal(entry.requestPath, "/api/admin/portal-orders/573");
    assert.equal(entry.resourceType, "PORTAL_ORDER");
    assert.equal(entry.resourceId, "573");
    assert.deepEqual(entry.metadata.assignedFulfillmentLocationIds, ["2"]);
    assert.deepEqual(entry.metadata.resourceFulfillmentLocationIds, ["1"]);
});

test("restricted attempts are retained and reviewable by super admins", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(source, /create table if not exists access_restriction_log/);
    assert.match(source, /statusCode === 403[\s\S]*recordAccessRestrictionAttempt/);
    assert.match(source, /\/api\/admin\/security\/access-restrictions", requireSuperAdmin\(\)/);
    assert.match(source, /insert into activity_log \(type, title, details\) values \('security', 'Access restricted'/);
});
