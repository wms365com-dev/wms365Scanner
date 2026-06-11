const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_PERMISSION_KEYS,
    assertPortalRequestAccountScope,
    assertPortalResourceAccount,
    getPortalRouteRule,
    sanitizePortalPermissionsInput,
    portalSessionHasPermission,
    assertPortalOrderCanReceiveDocuments
} = require("./server.js");

function portalSession(accountName, permissions = {}) {
    return {
        access: {
            accountName,
            email: "customer@example.com"
        },
        accessRow: {
            account_name: accountName,
            email: "customer@example.com",
            feature_flags: {
                CUSTOMER_PORTAL: true,
                ORDER_ENTRY: true,
                INBOUND_NOTICES: true,
                BILLING: true
            },
            portal_permissions: sanitizePortalPermissionsInput(permissions, {
                CUSTOMER_PORTAL: true,
                ORDER_ENTRY: true,
                INBOUND_NOTICES: true,
                BILLING: true
            })
        }
    };
}

function request({ method = "GET", url = "/api/portal/inventory", query = {}, body = {} } = {}) {
    return {
        method,
        originalUrl: url,
        url,
        query,
        body,
        headers: {},
        socket: { remoteAddress: "127.0.0.1" }
    };
}

test("portal middleware scope rejects query string account tampering", async () => {
    await assert.rejects(
        () => assertPortalRequestAccountScope(
            request({ query: { accountName: "CUSTOMER B" } }),
            portalSession("CUSTOMER A")
        ),
        (error) => error.statusCode === 403 && /limited to your own company/i.test(error.message)
    );
});

test("portal middleware scope rejects body account tampering", async () => {
    await assert.rejects(
        () => assertPortalRequestAccountScope(
            request({ method: "POST", url: "/api/portal/orders", body: { account_name: "CUSTOMER B" } }),
            portalSession("CUSTOMER A")
        ),
        (error) => error.statusCode === 403 && /limited to your own company/i.test(error.message)
    );
});

test("portal middleware scope allows same-account parameters", async () => {
    await assert.doesNotReject(() => assertPortalRequestAccountScope(
        request({ query: { accountName: "CUSTOMER A" }, body: { owner: "CUSTOMER A" } }),
        portalSession("CUSTOMER A")
    ));
});

test("portal document and invoice resources hide cross-account id guessing", async () => {
    await assert.rejects(
        () => assertPortalResourceAccount(
            portalSession("CUSTOMER A"),
            "CUSTOMER B",
            request({ url: "/api/portal/order-documents/99" }),
            { reason: "order_document_id_tampering", message: "That shipped document could not be found." }
        ),
        (error) => error.statusCode === 404 && /document could not be found/i.test(error.message)
    );
});

test("portal export route requires inventory permission", () => {
    const rule = getPortalRouteRule("GET", "/inventory/export.csv");
    assert.equal(rule.permission, PORTAL_PERMISSION_KEYS.INVENTORY);

    const session = portalSession("CUSTOMER A", {
        [PORTAL_PERMISSION_KEYS.INVENTORY]: false,
        [PORTAL_PERMISSION_KEYS.ORDER_ENTRY]: true,
        [PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS]: true,
        [PORTAL_PERMISSION_KEYS.BILLING]: true,
        [PORTAL_PERMISSION_KEYS.ADMIN]: false
    });
    assert.equal(portalSessionHasPermission(session, PORTAL_PERMISSION_KEYS.INVENTORY), false);
});

test("portal document routes require document permission", () => {
    assert.equal(getPortalRouteRule("GET", "/order-documents/10").permission, PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS);
    assert.equal(getPortalRouteRule("GET", "/inbound-documents/10").permission, PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS);
    assert.equal(getPortalRouteRule("GET", "/invoices/10/attachments").permission, PORTAL_PERMISSION_KEYS.BILLING);

    const session = portalSession("CUSTOMER A", {
        [PORTAL_PERMISSION_KEYS.INVENTORY]: true,
        [PORTAL_PERMISSION_KEYS.ORDER_ENTRY]: true,
        [PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS]: false,
        [PORTAL_PERMISSION_KEYS.BILLING]: false,
        [PORTAL_PERMISSION_KEYS.ADMIN]: false
    });
    assert.equal(portalSessionHasPermission(session, PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS), false);
    assert.equal(portalSessionHasPermission(session, PORTAL_PERMISSION_KEYS.BILLING), false);
});

test("portal billing routes require billing permission", () => {
    const rule = getPortalRouteRule("GET", "/invoices");
    assert.equal(rule.permission, PORTAL_PERMISSION_KEYS.BILLING);

    const session = portalSession("CUSTOMER A", {
        [PORTAL_PERMISSION_KEYS.INVENTORY]: true,
        [PORTAL_PERMISSION_KEYS.ORDER_ENTRY]: true,
        [PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS]: true,
        [PORTAL_PERMISSION_KEYS.BILLING]: false,
        [PORTAL_PERMISSION_KEYS.ADMIN]: false
    });
    assert.equal(portalSessionHasPermission(session, PORTAL_PERMISSION_KEYS.BILLING), false);
});

test("portal item maintenance requires admin permission while lookup stays inventory-only", () => {
    assert.equal(getPortalRouteRule("GET", "/items").permission, PORTAL_PERMISSION_KEYS.INVENTORY);
    assert.equal(getPortalRouteRule("POST", "/items").permission, PORTAL_PERMISSION_KEYS.ADMIN);
    assert.equal(getPortalRouteRule("PUT", "/items/123").permission, PORTAL_PERMISSION_KEYS.ADMIN);
});

test("customer portal cannot upload order documents after shipment", () => {
    assert.doesNotThrow(() => assertPortalOrderCanReceiveDocuments("STAGED", { allowShippedDocuments: false }));
    assert.doesNotThrow(() => assertPortalOrderCanReceiveDocuments("SHIPPED", { allowShippedDocuments: true }));
    assert.throws(
        () => assertPortalOrderCanReceiveDocuments("SHIPPED", { allowShippedDocuments: false }),
        (error) => error.statusCode === 400 && /shipped orders are locked/i.test(error.message)
    );
});
