const test = require("node:test");
const assert = require("node:assert/strict");

const {
    assertAppUserCustomerWarehouseAccess
} = require("./server");
const {
    auditAccessControlCoverage
} = require("./scripts/audit-access-control-coverage");

function scopedClient({ allowedAccount = "CUSTOMER A", assignedWarehouseId = 2, orderWarehouseId = 2 } = {}) {
    return {
        query: async (sql) => {
            const text = String(sql);
            if (/from app_user_company_access/i.test(text)) {
                return { rows: [{ account_name: allowedAccount }] };
            }
            if (/from app_user_fulfillment_location_access access/i.test(text)) {
                return { rows: [] };
            }
            if (/select fulfillment_location_id from app_user_fulfillment_location_access/i.test(text)) {
                return { rows: [{ fulfillment_location_id: assignedWarehouseId }] };
            }
            if (/from \(\s*select ws\.fulfillment_location_id/i.test(text)) {
                return { rows: [{ fulfillment_location_id: orderWarehouseId }] };
            }
            throw new Error(`Unexpected query: ${text}`);
        }
    };
}

const warehouseUser = {
    id: 51,
    email: "warehouse@example.com",
    role: "warehouse_customer_service",
    assigned_fulfillment_locations: [{ id: "2", code: "EDWARDS" }]
};

test("customer and warehouse access must both match the requested order", async () => {
    const result = await assertAppUserCustomerWarehouseAccess(scopedClient(), warehouseUser, {
        accountName: "CUSTOMER A",
        orderId: 900,
        resourceType: "PORTAL_ORDER",
        resourceId: 900
    });
    assert.equal(result.accountName, "CUSTOMER A");
    assert.deepEqual(result.fulfillmentLocationIds, [2]);
});

test("matching warehouse does not permit access to another customer", async () => {
    await assert.rejects(
        () => assertAppUserCustomerWarehouseAccess(scopedClient(), warehouseUser, {
            accountName: "CUSTOMER B",
            orderId: 900
        }),
        (error) => error.statusCode === 403
            && error.code === "ACCESS_RESTRICTED"
            && error.accessRestriction?.resourceType === "CUSTOMER_ACCOUNT"
    );
});

test("matching customer does not permit access to another warehouse", async () => {
    await assert.rejects(
        () => assertAppUserCustomerWarehouseAccess(scopedClient({ orderWarehouseId: 1 }), warehouseUser, {
            accountName: "CUSTOMER A",
            orderId: 900
        }),
        (error) => error.statusCode === 403
            && error.code === "ACCESS_RESTRICTED"
            && error.accessRestriction?.resourceType === "PORTAL_ORDER"
    );
});

test("the release audit fails closed when a protected route bypasses the order guard", () => {
    const source = `
        app.get("/api/admin/portal-orders/:id/leak", async () => {});
        app.use("/api/admin/portal-orders/:id", async () => {
            await assertAppUserCustomerWarehouseAccess();
        });
    `;
    const result = auditAccessControlCoverage(source);
    assert.equal(result.passed, false);
    assert.match(result.failures.join("\n"), /registered before the central guard/i);
});

test("the current application passes the customer and warehouse access-control audit", () => {
    const result = auditAccessControlCoverage();
    assert.equal(result.passed, true, result.failures.join("\n"));
    assert.ok(result.protectedOrderRouteCount > 0);
    assert.ok(result.customerPortalRouteCount > 0);
});
