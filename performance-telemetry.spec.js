const test = require("node:test");
const assert = require("node:assert/strict");

const {
    normalizePerformancePath,
    getPerformanceRoleClass,
    buildPerformanceEvent
} = require("./server");

test("performance routes remove record ids, UUIDs, long tokens, and query strings", () => {
    const route = normalizePerformancePath(
        "/api/portal/orders/ORD-002242/8d7d765e-2b11-42aa-b38a-1026d990c9af/abcdefghijklmnopqrstuvwxyz123456?email=private@example.com"
    );
    assert.equal(route, "/api/portal/orders/:record/:uuid/:token");
    assert.doesNotMatch(route, /002242|private|8d7d765e|abcdefghijklmnopqrstuvwxyz/);
});

test("performance events contain bounded operational fields without request data", () => {
    const req = {
        requestId: "request-123",
        method: "GET",
        originalUrl: "/api/admin/portal-orders/2192?accountName=private",
        path: "/api/admin/portal-orders/2192",
        appUser: { role: "WAREHOUSE_ADMIN", email: "private@example.com" }
    };
    const res = {
        statusCode: 200,
        getHeader(name) {
            return String(name).toLowerCase() === "content-length" ? "512" : undefined;
        }
    };
    const event = buildPerformanceEvent(req, res, 18.26);
    assert.deepEqual(event, {
        type: "wms365.performance",
        requestId: "request-123",
        method: "GET",
        route: "/api/admin/portal-orders/:id",
        roleClass: "ADMIN",
        status: 200,
        durationMs: 18.3,
        responseBytes: 512,
        outcome: "success"
    });
    assert.equal(getPerformanceRoleClass(req), "ADMIN");
    assert.doesNotMatch(JSON.stringify(event), /private|2192|accountName/);
});

test("performance events classify errors without logging error bodies", () => {
    const event = buildPerformanceEvent(
        { requestId: "request-500", method: "POST", path: "/api/portal/orders", appUser: null },
        { statusCode: 503, getHeader: () => undefined },
        901
    );
    assert.equal(event.roleClass, "CUSTOMER_PORTAL");
    assert.equal(event.outcome, "server_error");
    assert.equal(event.responseBytes, null);
});

test("registered Express route patterns take precedence over raw path values", () => {
    const event = buildPerformanceEvent(
        {
            requestId: "request-route",
            method: "GET",
            originalUrl: "/api/private-company/orders/2192",
            baseUrl: "",
            route: { path: "/api/admin/portal-orders/:id" },
            appUser: { role: "SUPER_ADMIN" }
        },
        { statusCode: 200, getHeader: () => undefined },
        3
    );
    assert.equal(event.route, "/api/admin/portal-orders/:id");
    assert.equal(event.roleClass, "SUPER_ADMIN");
    assert.doesNotMatch(JSON.stringify(event), /private-company|2192/);
});
