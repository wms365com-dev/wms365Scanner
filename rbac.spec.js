const test = require("node:test");
const assert = require("node:assert/strict");

const {
    APP_USER_ROLES,
    CUSTOMER_PORTAL_ROLE,
    RBAC_PERMISSIONS,
    roleHasPermission,
    requireWarehouseAdmin,
    requireInventoryAdjustPermission,
    requireMobileWorkerAction,
    taskTypesForPortalInboundStatus,
    assertPortalAccountAccess
} = require("./server");

function runMiddleware(middleware, req) {
    return new Promise((resolve) => {
        middleware(req, {}, (error) => resolve(error || null));
    });
}

function appUser(role) {
    return {
        id: "10",
        email: `${role}@example.com`,
        full_name: role,
        role,
        is_active: true
    };
}

test("worker cannot approve inventory count", async () => {
    const error = await runMiddleware(requireWarehouseAdmin(), {
        method: "POST",
        originalUrl: "/api/inventory-counts/123/approve",
        appUser: appUser(APP_USER_ROLES.WAREHOUSE_WORKER)
    });

    assert.equal(error?.statusCode, 403);
    assert.match(error.message, /Warehouse admin access/i);
});

test("worker cannot post inventory count", async () => {
    const error = await runMiddleware(requireInventoryAdjustPermission(), {
        method: "POST",
        originalUrl: "/api/inventory-counts/123/post",
        appUser: appUser(APP_USER_ROLES.WAREHOUSE_WORKER)
    });

    assert.equal(error?.statusCode, 403);
    assert.match(error.message, /Inventory adjustment access/i);
});

test("customer portal user cannot access another account", () => {
    assert.throws(
        () => assertPortalAccountAccess({ access: { accountName: "CUSTOMER A" } }, "CUSTOMER B"),
        (error) => error.statusCode === 403 && /limited to your own company/i.test(error.message)
    );
});

test("customer portal user cannot manipulate warehouse order statuses", () => {
    assert.equal(roleHasPermission(CUSTOMER_PORTAL_ROLE, RBAC_PERMISSIONS.ORDER_STATUS_UPDATE), false);
    assert.equal(roleHasPermission(CUSTOMER_PORTAL_ROLE, RBAC_PERMISSIONS.INBOUND_STATUS_UPDATE), false);
    assert.equal(roleHasPermission(CUSTOMER_PORTAL_ROLE, RBAC_PERMISSIONS.INVENTORY_ADJUST), false);
});

test("super admin bypass works for protected middleware", async () => {
    const error = await runMiddleware(requireInventoryAdjustPermission(), {
        method: "POST",
        originalUrl: "/api/inventory-counts/123/post",
        appUser: appUser(APP_USER_ROLES.SUPER_ADMIN)
    });

    assert.equal(error, null);
    assert.equal(roleHasPermission(APP_USER_ROLES.SUPER_ADMIN, RBAC_PERMISSIONS.DESTRUCTIVE_IMPORT), true);
});

test("mobile worker action permission is limited to worker-safe actions", async () => {
    const allowed = await runMiddleware(requireMobileWorkerAction(), {
        method: "POST",
        originalUrl: "/api/inventory-counts",
        appUser: appUser(APP_USER_ROLES.WAREHOUSE_WORKER)
    });
    const denied = await runMiddleware(requireInventoryAdjustPermission(), {
        method: "POST",
        originalUrl: "/api/remove-quantity",
        appUser: appUser(APP_USER_ROLES.WAREHOUSE_WORKER)
    });

    assert.equal(allowed, null);
    assert.equal(denied?.statusCode, 403);
});

test("inbound mobile status gates keep receiving and putaway assigned-task safe", () => {
    assert.deepEqual(taskTypesForPortalInboundStatus("ARRIVED"), ["INBOUND_ARRIVAL"]);
    assert.deepEqual(taskTypesForPortalInboundStatus("RECEIVED"), ["RECEIVING", "PUT_AWAY"]);
    assert.deepEqual(taskTypesForPortalInboundStatus("RECEIVED_PENDING_PUTAWAY"), ["PUT_AWAY"]);
    assert.deepEqual(taskTypesForPortalInboundStatus("PUTAWAY_COMPLETE"), ["PUT_AWAY"]);
});
