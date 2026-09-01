const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT_DIR, "server.js");

function routeRegistrations(source) {
    const routes = [];
    const pattern = /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        routes.push({ method: match[1].toUpperCase(), path: match[2], index: match.index });
    }
    return routes;
}

function routeSection(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) return "";
    const nextRoute = source.indexOf("\napp.", start + signature.length);
    return source.slice(start, nextRoute < 0 ? source.length : nextRoute);
}

function auditAccessControlCoverage(source = fs.readFileSync(SERVER_PATH, "utf8")) {
    const failures = [];
    const checks = [];
    const requireText = (name, value, pattern, message) => {
        const passed = pattern.test(value);
        checks.push({ name, passed });
        if (!passed) failures.push(message);
    };

    const routes = routeRegistrations(source);
    const globalAuthIndex = source.indexOf("if (!requiresAppAuth(req))");
    const firstProtectedApiIndex = routes
        .filter((route) => route.path.startsWith("/api/") && !route.path.startsWith("/api/portal/"))
        .reduce((minimum, route) => Math.min(minimum, route.index), Number.POSITIVE_INFINITY);
    checks.push({ name: "global warehouse authentication precedes protected API routes", passed: globalAuthIndex >= 0 && globalAuthIndex < firstProtectedApiIndex });
    if (globalAuthIndex < 0 || globalAuthIndex >= firstProtectedApiIndex) {
        failures.push("Global warehouse authentication must run before protected API routes.");
    }

    const orderGuardSignature = "app.use(\"/api/admin/portal-orders/:id\"";
    const orderGuardIndex = source.indexOf(orderGuardSignature);
    const orderGuardSection = routeSection(source, orderGuardSignature);
    requireText(
        "order guard enforces customer and warehouse intersection",
        orderGuardSection,
        /assertAppUserCustomerWarehouseAccess/,
        "The sales-order guard must enforce customer and warehouse access through the central policy helper."
    );
    const unguardedOrderRoutes = routes.filter((route) => route.path.startsWith("/api/admin/portal-orders/:id") && route.index < orderGuardIndex);
    checks.push({ name: "all order-id routes are registered after the central guard", passed: orderGuardIndex >= 0 && unguardedOrderRoutes.length === 0 });
    if (orderGuardIndex < 0 || unguardedOrderRoutes.length) {
        failures.push(`Protected order routes registered before the central guard: ${unguardedOrderRoutes.map((route) => `${route.method} ${route.path}`).join(", ") || "guard missing"}.`);
    }

    const orderListSection = routeSection(source, "app.get(\"/api/admin/portal-orders\"");
    requireText(
        "order list applies customer scope",
        orderListSection,
        /allowedCompanies[\s\S]*companyScopedOrders/,
        "The warehouse order list must filter records to assigned customers."
    );
    requireText(
        "order list applies warehouse scope after customer scope",
        orderListSection,
        /filterPortalOrdersForAppUserWarehouses\(pool, companyScopedOrders, req\.appUser\)/,
        "The warehouse order list must apply warehouse scope after customer scope."
    );

    const batchPrintSection = routeSection(source, "app.get(\"/api/admin/portal-orders/batch-pick-tickets.pdf\"");
    requireText(
        "batch pick-ticket printing enforces both scopes",
        batchPrintSection,
        /assertAppUserCustomerWarehouseAccess/,
        "Batch pick-ticket printing must enforce both customer and warehouse access."
    );

    const documentSection = routeSection(source, "app.get(\"/api/admin/portal-order-documents/:id\"");
    requireText(
        "order document preview and download enforce both scopes",
        documentSection,
        /assertAppUserCustomerWarehouseAccess/,
        "Order documents must enforce both customer and warehouse access before sending content."
    );

    const shipmentSection = routeSection(source, "app.patch(\"/api/admin/warehouse-shipments/:id\"");
    requireText(
        "warehouse shipment changes enforce both scopes",
        shipmentSection,
        /assertAppUserCustomerWarehouseAccess/,
        "Warehouse shipment changes must enforce both customer and warehouse access."
    );

    const portalScopeIndex = source.indexOf("app.use(\"/api/portal\", portalAccountScopeMiddleware())");
    const earlyPortalRoutes = routes.filter((route) => route.path.startsWith("/api/portal/") && route.index < portalScopeIndex);
    checks.push({ name: "all customer portal routes inherit tenant scope", passed: portalScopeIndex >= 0 && earlyPortalRoutes.length === 0 });
    if (portalScopeIndex < 0 || earlyPortalRoutes.length) {
        failures.push(`Customer portal routes bypass the tenant-scope middleware: ${earlyPortalRoutes.map((route) => `${route.method} ${route.path}`).join(", ") || "middleware missing"}.`);
    }

    requireText(
        "customer resource identifiers are checked against portal tenant",
        source,
        /async function assertPortalResourceAccount[\s\S]*logPortalScopeViolation/,
        "Customer portal resources must reject cross-customer identifier access."
    );
    requireText(
        "restricted decisions are logged centrally",
        source,
        /statusCode === 403[\s\S]*recordAccessRestrictionAttempt/,
        "Every restricted access decision must be written to the security audit log."
    );
    requireText(
        "release notification recipients are warehouse scoped",
        source,
        /getPortalOrderReleaseRecipients[\s\S]*assigned_fulfillment_location_ids/,
        "Warehouse release recipients must be derived from the order warehouse assignment."
    );

    return {
        passed: failures.length === 0,
        generatedAt: new Date().toISOString(),
        routeCount: routes.length,
        protectedOrderRouteCount: routes.filter((route) => route.path.startsWith("/api/admin/portal-orders/:id")).length,
        customerPortalRouteCount: routes.filter((route) => route.path.startsWith("/api/portal/")).length,
        checks,
        failures
    };
}

if (require.main === module) {
    const result = auditAccessControlCoverage();
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
}

module.exports = {
    auditAccessControlCoverage,
    routeRegistrations,
    routeSection
};
