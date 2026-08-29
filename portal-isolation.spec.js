const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_PERMISSION_KEYS,
    assertPortalRequestAccountScope,
    assertPortalResourceAccount,
    getPortalRouteRule,
    sanitizePortalPermissionsInput,
    portalSessionHasPermission,
    assertPortalOrderCanReceiveDocuments,
    buildCompanyBillingHoldPayload,
    createCompanyBillingHoldError,
    mapShopifyOrderToPortalDraft,
    buildPortalOrderProcessingTiming,
    buildPortalOrderConfirmationEmailText,
    buildPortalOrderPickTicketLines,
    buildPortalOrderStockWarnings,
    portalOrderRequiresRushApproval
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

test("inbound-only portal permission allows inbound inputs and blocks unrelated areas", () => {
    const permissions = {
        [PORTAL_PERMISSION_KEYS.INVENTORY]: false,
        [PORTAL_PERMISSION_KEYS.ORDER_ENTRY]: false,
        [PORTAL_PERMISSION_KEYS.INBOUND_ENTRY]: true,
        [PORTAL_PERMISSION_KEYS.DOCUMENT_ACCESS]: false,
        [PORTAL_PERMISSION_KEYS.BILLING]: false,
        [PORTAL_PERMISSION_KEYS.ADMIN]: false
    };
    const session = portalSession("PACK TECH A/S", permissions);

    assert.equal(getPortalRouteRule("POST", "/inbounds").permission, PORTAL_PERMISSION_KEYS.INBOUND_ENTRY);
    assert.equal(getPortalRouteRule("POST", "/inbounds/12/documents").permission, PORTAL_PERMISSION_KEYS.INBOUND_ENTRY);
    assert.equal(getPortalRouteRule("POST", "/delivery-appointments").permission, PORTAL_PERMISSION_KEYS.INBOUND_ENTRY);
    assert.equal(portalSessionHasPermission(session, getPortalRouteRule("GET", "/items").permission), true);
    assert.equal(portalSessionHasPermission(session, getPortalRouteRule("GET", "/fulfillment-locations").permission), true);

    for (const [method, path] of [
        ["GET", "/inventory"],
        ["GET", "/orders"],
        ["GET", "/invoices"],
        ["GET", "/jobs"],
        ["POST", "/items"]
    ]) {
        assert.equal(portalSessionHasPermission(session, getPortalRouteRule(method, path).permission), false, `${method} ${path}`);
    }
});

test("customer order drafts report shortages without treating unavailable stock as releasable", () => {
    const warnings = buildPortalOrderStockWarnings([
        { sku: "140", quantity: 124, availableQuantity: 0, trackingLevel: "CASE" },
        { sku: "145", quantity: 2, availableQuantity: 0, trackingLevel: "CASE" },
        { sku: "200", quantity: 3, availableQuantity: 5, trackingLevel: "CASE" }
    ]);

    assert.deepEqual(warnings.map((warning) => warning.sku), ["140", "145"]);
    assert.equal(warnings[0].shortQuantity, 124);
    assert.match(warnings[0].message, /save as draft is allowed/i);
    assert.match(warnings[0].message, /release is blocked/i);
});

test("customer order draft shortage warning groups duplicate SKU lines", () => {
    const warnings = buildPortalOrderStockWarnings([
        { sku: "133", quantity: 4, availableQuantity: 5, trackingLevel: "CASE" },
        { sku: "133", quantity: 3, availableQuantity: 5, trackingLevel: "CASE" }
    ]);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].requestedQuantity, 7);
    assert.equal(warnings[0].availableQuantity, 5);
    assert.equal(warnings[0].shortQuantity, 2);
});

test("released orders do not report their own allocations as stock shortages", () => {
    const warnings = buildPortalOrderStockWarnings([
        { sku: "20628693486143", quantity: 10, availableQuantity: 0, trackingLevel: "CASE" },
        { sku: "20628693486167", quantity: 18, availableQuantity: 0, trackingLevel: "CASE" }
    ], { status: "RELEASED" });

    assert.deepEqual(warnings, []);
});

test("company billing hold payload disables portal actions and recovery", () => {
    const hold = buildCompanyBillingHoldPayload({
        accountName: "ACME FOODS",
        status: "PAST_DUE",
        planKey: "LAUNCH_WAREHOUSE",
        reason: "Payment failed"
    });

    assert.equal(hold.active, true);
    assert.equal(hold.code, "BILLING_HOLD");
    assert.equal(hold.accountName, "ACME FOODS");
    assert.equal(hold.actionsDisabled, true);
    assert.equal(hold.passwordRecoveryDisabled, true);
    assert.match(hold.message, /Billing or Sales/i);
    assert.equal(hold.reason, "Payment failed");
});

test("company billing hold error includes structured hold details", () => {
    const error = createCompanyBillingHoldError({
        accountName: "ACME FOODS",
        status: "BLOCKED",
        reason: "Accounting hold"
    });

    assert.equal(error.statusCode, 402);
    assert.equal(error.code, "PORTAL_BILLING_HOLD");
    assert.equal(error.billingHold.active, true);
    assert.equal(error.billingHold.actionsDisabled, true);
    assert.equal(error.billingHold.passwordRecoveryDisabled, true);
});

test("portal item maintenance requires admin permission while lookup supports authorized workflows", () => {
    assert.deepEqual(getPortalRouteRule("GET", "/items").permission, [
        PORTAL_PERMISSION_KEYS.INVENTORY,
        PORTAL_PERMISSION_KEYS.ORDER_ENTRY,
        PORTAL_PERMISSION_KEYS.INBOUND_ENTRY
    ]);
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

test("portal rush approval is required when requested date is before the 48-hour ready date", () => {
    const now = new Date("2026-07-15T14:00:00.000Z");
    assert.equal(portalOrderRequiresRushApproval({
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "PARCEL",
        requestedShipDate: "2026-07-16"
    }, now), true);
    assert.equal(portalOrderRequiresRushApproval({
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "PARCEL",
        requestedShipDate: "2026-07-17"
    }, now), false);
});

test("portal rush exemption suppresses required rush marker without approving rush", () => {
    const timing = buildPortalOrderProcessingTiming({
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        requestedShipDate: "2026-07-16",
        rushApproved: false,
        rushExempt: true
    }, {
        now: new Date("2026-07-15T14:00:00.000Z")
    });

    assert.equal(timing.requestedBeforeReady, true);
    assert.equal(timing.rushRequired, false);
    assert.equal(timing.rushApproved, false);
    assert.equal(timing.rushExempt, true);
});

test("portal rush approval skips B2C parcel but still applies to non-parcel online orders", () => {
    const now = new Date("2026-07-15T14:00:00.000Z");
    assert.equal(portalOrderRequiresRushApproval({
        orderType: "B2C_ONLINE",
        shipmentMethod: "PARCEL",
        requestedShipDate: "2026-07-15"
    }, now), false);
    assert.equal(portalOrderRequiresRushApproval({
        orderType: "B2C_ONLINE",
        shipmentMethod: "LTL_FREIGHT",
        requestedShipDate: "2026-07-16"
    }, now), true);
    assert.equal(portalOrderRequiresRushApproval({
        orderType: "B2C_ONLINE",
        shipmentMethod: "CUSTOMER_PICKUP",
        requestedShipDate: "2026-07-16"
    }, now), true);
});

test("Shopify imports are treated as online parcel orders without rush approval", () => {
    const payload = mapShopifyOrderToPortalDraft("SHOPIFY CUSTOMER", {
        id: 991122,
        name: "#1001",
        order_number: 1001,
        processed_at: "2026-07-15T19:30:00.000Z",
        email: "buyer@example.com",
        shipping_address: {
            name: "Buyer Example",
            address1: "123 Main Street",
            city: "Toronto",
            province_code: "ON",
            zip: "M5V 1A1",
            country_code: "CA",
            phone: "416-555-0199"
        },
        line_items: [
            { sku: "SKU-ONLINE", fulfillable_quantity: 2, quantity: 2 }
        ]
    }, {
        store_identifier: "example.myshopify.com"
    });

    assert.equal(payload.orderType, "B2C_ONLINE");
    assert.equal(payload.shipmentMethod, "PARCEL");
    assert.equal(portalOrderRequiresRushApproval(payload, new Date("2026-07-15T19:30:00.000Z")), false);
    assert.match(payload.orderNotes, /Imported from Shopify/i);
});

test("pick ticket rush approval line does not print the rush fee amount", () => {
    const lines = buildPortalOrderPickTicketLines({
        orderCode: "ORD-TEST",
        accountName: "CUSTOMER A",
        status: "RELEASED",
        poNumber: "PO-1",
        shippingReference: "REF-1",
        requestedShipDate: "2026-07-16",
        releasedAt: "2026-07-15T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "PARCEL",
        rushApproved: true,
        contactName: "Receiver",
        contactPhone: "555-0100",
        shipToName: "Receiver",
        shipToAddress1: "1 Test Road",
        shipToCity: "Toronto",
        shipToState: "ON",
        shipToPostalCode: "M1M 1M1",
        shipToCountry: "Canada",
        lines: [
            {
                lineNumber: 1,
                sku: "SKU-1",
                quantity: 1,
                trackingLevel: "CASE",
                pickLocations: [{ location: "GW3PL-MISS-A01", quantity: 1, trackingLevel: "CASE" }]
            }
        ]
    }).join("\n");

    assert.match(lines, /RUSH APPROVED: Expedited processing was approved/i);
    assert.doesNotMatch(lines, /\$25|minimum rush charge|plus handling fees/i);
});

test("portal order confirmation email hides rush fee amount and points to sales", () => {
    const text = buildPortalOrderConfirmationEmailText({
        orderCode: "ORD-RUSH",
        accountName: "CUSTOMER A",
        poNumber: "PO-RUSH",
        shippingReference: "REF-RUSH",
        requestedShipDate: "2026-07-15",
        releasedAt: "2026-07-15T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        rushApproved: true,
        fulfillmentCountry: "Canada",
        lines: [
            { sku: "SKU-1", quantity: 1, trackingLevel: "CASE", description: "Rush item" }
        ]
    }, [], { reason: "Customer portal order release" });

    assert.match(text, /RUSH Approved: expedited processing was approved/i);
    assert.match(text, /info@greywolf3pl\.com/i);
    assert.doesNotMatch(text, /\$25|minimum rush charge|plus handling fees/i);
});

test("portal expected ready date skips weekends and Canadian holiday closures", () => {
    const timing = buildPortalOrderProcessingTiming({
        status: "RELEASED",
        releasedAt: "2026-06-29T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        requestedShipDate: "2026-07-02",
        fulfillmentCountry: "Canada"
    });
    assert.equal(timing.expectedReadyDate, "2026-07-02");
    assert.match(timing.expectedReadyLabel, /Thu, Jul 2, 2026/);
    assert.deepEqual(timing.holidayClosures.map((holiday) => holiday.name), ["Canada Day"]);
});

test("portal expected ready date starts next business morning after hours", () => {
    const timing = buildPortalOrderProcessingTiming({
        status: "RELEASED",
        releasedAt: "2026-07-03T21:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "CUSTOMER_PICKUP",
        requestedShipDate: "2026-07-08",
        fulfillmentCountry: "Canada"
    });
    assert.equal(timing.expectedReadyDate, "2026-07-08");
    assert.match(timing.expectedReadyLabel, /Wed, Jul 8, 2026, 8:00 AM/);
});

test("portal ready date uses the fulfillment warehouse holiday calendar", () => {
    const order = {
        status: "RELEASED",
        releasedAt: "2026-09-29T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        requestedShipDate: "2026-10-01",
        fulfillmentCountry: "Canada",
        fulfillmentState: "Ontario"
    };
    const ontarioTiming = buildPortalOrderProcessingTiming(order, {
        location: { country: "Canada", state: "Ontario", publicName: "Grey Wolf Main Warehouse" }
    });
    const bcTiming = buildPortalOrderProcessingTiming(order, {
        location: { country: "Canada", state: "British Columbia", publicName: "Grey Wolf BC Warehouse" }
    });

    assert.equal(ontarioTiming.expectedReadyDate, "2026-10-01");
    assert.equal(bcTiming.expectedReadyDate, "2026-10-02");
    assert.deepEqual(ontarioTiming.holidayClosures.map((holiday) => holiday.name), []);
    assert.deepEqual(bcTiming.holidayClosures.map((holiday) => holiday.name), ["National Day for Truth and Reconciliation"]);
    assert.match(bcTiming.holidayWarning, /Holiday closure affects this order/);
});

test("portal split-location confirmation email shows each warehouse ready date and holiday warning", () => {
    const order = {
        id: "402",
        orderCode: "ORD-000402",
        accountName: "ZETA GROUP BC",
        poNumber: "PO-SEPT-30",
        requestedShipDate: "2026-10-01",
        releasedAt: "2026-09-29T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        fulfillmentCountry: "Canada",
        fulfillmentState: "Ontario",
        lines: [
            { sku: "SKU-ON", quantity: 4, trackingLevel: "CASE", description: "Ontario item" },
            { sku: "SKU-BC", quantity: 6, trackingLevel: "CASE", description: "BC item" }
        ]
    };
    const groups = [
        {
            location: {
                publicName: "Grey Wolf ON Warehouse",
                address: "Mississauga, ON",
                country: "Canada",
                state: "Ontario"
            },
            totalQuantity: 4
        },
        {
            location: {
                publicName: "Grey Wolf BC Warehouse",
                address: "Delta, BC",
                country: "Canada",
                state: "British Columbia"
            },
            totalQuantity: 6
        }
    ];

    const text = buildPortalOrderConfirmationEmailText(order, groups, { reason: "Customer portal order release" });
    assert.match(text, /Grey Wolf ON Warehouse:.*Thu, Oct 1, 2026/s);
    assert.match(text, /Grey Wolf BC Warehouse:.*Fri, Oct 2, 2026/s);
    assert.match(text, /National Day for Truth and Reconciliation/);
});

test("portal order confirmation email shows ready date warnings and split locations", () => {
    const order = {
        id: "391",
        orderCode: "ORD-000391",
        accountName: "PURE FOODS BY ESTEE",
        poNumber: "PO110284",
        shippingReference: "PO110284",
        requestedShipDate: "2026-07-02",
        releasedAt: "2026-06-29T14:00:00.000Z",
        orderType: "RETAIL_WHOLESALE",
        shipmentMethod: "LTL_FREIGHT",
        fulfillmentCountry: "Canada",
        lines: [
            { sku: "SKU-A", quantity: 10, trackingLevel: "CASE", description: "Main warehouse item" },
            { sku: "SKU-B", quantity: 5, trackingLevel: "CASE", description: "Edwards item" }
        ]
    };
    const groups = [
        {
            location: {
                publicName: "Grey Wolf Main Warehouse",
                address: "1330 Courtney Park Drive East, Mississauga, ON",
                country: "Canada"
            },
            totalQuantity: 10
        },
        {
            location: {
                publicName: "Grey Wolf Edwards Warehouse",
                address: "4400 Poth Road, Whitehall, OH",
                country: "USA"
            },
            totalQuantity: 5
        }
    ];

    const text = buildPortalOrderConfirmationEmailText(order, groups, { reason: "Customer portal order release" });
    assert.match(text, /Earliest ready date:/);
    assert.match(text, /Holiday closure affects this order; earliest ready date has been pushed/);
    assert.match(text, /If this order is edited after submission, the expected ready date will recalculate/);
    assert.match(text, /Grey Wolf Main Warehouse/);
    assert.match(text, /Grey Wolf Edwards Warehouse/);
});
