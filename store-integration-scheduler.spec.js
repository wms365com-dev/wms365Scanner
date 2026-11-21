const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
    STORE_INTEGRATION_SCHEDULE_TIME_ZONE,
    STORE_INTEGRATION_SYNC_CLAIM_STALE_MINUTES,
    computeNextStoreIntegrationSyncAt,
    claimStoreIntegrationSync,
    releaseStoreIntegrationSyncClaim,
    lockAndFindStoreOrderImport,
    sanitizeStoreIntegrationSettingsInput,
    normalizeStoreOrderCountry,
    getShopifyOrderShipCountryDecision,
    applyStoreSkuMappingsToPortalOrderPayload,
    getItemKitComponentLookup,
    buildPortalOrderPickTicketLines,
    exportShopifyInventoryLevels,
    createIntegrationCredentialRequestToken,
    hashIntegrationCredentialRequestToken,
    buildIntegrationCredentialRequestUrl,
    renderIntegrationCredentialRequestPage,
    normalizeSubmittedIntegrationCredential,
    testSubmittedShopifyCredential,
    normalizeSecureShopifyConfiguration,
    SHOPIFY_APP_SCOPES,
    normalizeShopifyShopDomain,
    buildShopifyHmacMessage,
    verifyShopifyRequestHmac,
    signShopifyOAuthState,
    verifyShopifyOAuthState,
    normalizeShopifyTrackingCompany,
    buildShopifyFulfillmentTrackingInfo,
    buildShopifyFulfillmentRequestBody,
    buildShopifyFulfillmentExportPayload,
    selectShopifyFulfillmentForTrackingUpdate
} = require("./server");

test("Shopify fulfillment sends an explicit ICS Courier tracking link", () => {
    const order = {
        orderCode: "TEST-ORDER",
        shippedCarrierName: "ICS",
        shippedTrackingReference: "GR6C2B123456789V9M1M1"
    };
    assert.equal(normalizeShopifyTrackingCompany("ICS"), "ICS Courier");
    assert.deepEqual(buildShopifyFulfillmentTrackingInfo(order), {
        number: "GR6C2B123456789V9M1M1",
        company: "ICS Courier",
        url: "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=GR6C2B123456789V9M1M1"
    });
    assert.deepEqual(buildShopifyFulfillmentRequestBody(order, [{ id: 42 }], { notifyCustomer: true }), {
        fulfillment: {
            line_items_by_fulfillment_order: [{ fulfillment_order_id: 42 }],
            notify_customer: true,
            message: "Shipped from WMS365 for TEST-ORDER",
            tracking_info: {
                number: "GR6C2B123456789V9M1M1",
                company: "ICS Courier",
                url: "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=GR6C2B123456789V9M1M1"
            }
        }
    });
    assert.equal(
        buildShopifyFulfillmentExportPayload(order, "shopify-order-1").shippedTrackingUrl,
        "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=GR6C2B123456789V9M1M1"
    );
});

test("Shopify fulfillment sends every package tracking number for one carrier", () => {
    const order = {
        orderCode: "TEST-MULTI-CANPAR",
        shippedCarrierName: "Canpar Ground",
        shippedTrackingReference: "D420352470002689994001\nD420352470002690578001",
        shipmentTracking: [
            {
                carrierName: "Canpar",
                trackingNumber: "D420352470002689994001",
                trackingUrl: "https://www.canpar.com/en/tracking/track.htm?barcode=D420352470002689994001"
            },
            {
                carrierName: "Canpar",
                trackingNumber: "D420352470002690578001",
                trackingUrl: "https://www.canpar.com/en/tracking/track.htm?barcode=D420352470002690578001"
            }
        ]
    };

    assert.deepEqual(buildShopifyFulfillmentTrackingInfo(order), {
        numbers: ["D420352470002689994001", "D420352470002690578001"],
        urls: [
            "https://www.canpar.com/en/tracking/track.htm?barcode=D420352470002689994001",
            "https://www.canpar.com/en/tracking/track.htm?barcode=D420352470002690578001"
        ],
        company: "Canpar"
    });
});

test("Shopify fulfillment keeps mixed-carrier package links without applying the wrong company", () => {
    const order = {
        orderCode: "TEST-MULTI-MIXED",
        shippedCarrierName: "GLS",
        shippedTrackingReference: "P61569126\nD556276790000149108001",
        shipmentTracking: [
            {
                carrierName: "GLS",
                trackingNumber: "P61569126",
                trackingUrl: "https://ship.gls-canada.com/tracking/P61569126"
            },
            {
                carrierName: "Canpar",
                trackingNumber: "D556276790000149108001",
                trackingUrl: "https://www.canpar.com/en/tracking/track.htm?barcode=D556276790000149108001"
            }
        ]
    };

    assert.deepEqual(buildShopifyFulfillmentTrackingInfo(order), {
        numbers: ["P61569126", "D556276790000149108001"],
        urls: [
            "https://ship.gls-canada.com/tracking/P61569126",
            "https://www.canpar.com/en/tracking/track.htm?barcode=D556276790000149108001"
        ]
    });
});

test("Shopify fulfillment tracking updates select only an unambiguous fulfillment", () => {
    assert.equal(selectShopifyFulfillmentForTrackingUpdate([
        { id: 10, status: "success", tracking_number: "OLD" },
        { id: 11, status: "success", tracking_number: "GR6C2B123456789V9M1M1" }
    ], "GR6C2B123456789V9M1M1").id, 11);
    assert.equal(selectShopifyFulfillmentForTrackingUpdate([
        { id: 10, status: "success", tracking_number: "OLD-A" },
        { id: 11, status: "success", tracking_number: "OLD-B" }
    ], "NEW"), null);
    assert.equal(selectShopifyFulfillmentForTrackingUpdate([
        { id: 12, status: "success", tracking_number: "OLD" }
    ], "NEW"), null);
    assert.equal(selectShopifyFulfillmentForTrackingUpdate([
        { id: 13, status: "success", tracking_number: null, tracking_numbers: [] }
    ], "NEW").id, 13);
});

test("store SKU mappings convert Shopify pack quantities into WMS base units", () => {
    const mapped = applyStoreSkuMappingsToPortalOrderPayload({
        lines: [{ sku: "6-Pack", quantity: 2 }]
    }, new Map([
        ["6-PACK", { localSku: "RTC-4OZ-12", localQuantityMultiplier: 6 }]
    ]));

    assert.deepEqual(mapped.lines, [{
        sku: "RTC-4OZ-12",
        quantity: 12,
        externalSku: "6-PACK",
        externalQuantity: 2,
        localQuantityMultiplier: 6
    }]);
});

test("store kit mappings expand each Shopify gift into tenant-scoped component eaches", () => {
    const mapped = applyStoreSkuMappingsToPortalOrderPayload({
        lines: [{ sku: "NOMMM-FOUNDER-GIFT-3PK", quantity: 3 }]
    }, new Map([
        ["NOMMM-FOUNDER-GIFT-3PK", { localSku: "NOMMM-FOUNDER-GIFT-3PK", localQuantityMultiplier: 1 }]
    ]), new Map([
        ["NOMMM-FOUNDER-GIFT-3PK", [
            { componentSku: "NN95034", quantityPerParent: 2 },
            { componentSku: "NN95035", quantityPerParent: 2 },
            { componentSku: "NN95033", quantityPerParent: 2 }
        ]]
    ]));

    assert.deepEqual(mapped.lines.map(({ sku, quantity, kitParentSku, kitQuantityPerParent }) => ({
        sku, quantity, kitParentSku, kitQuantityPerParent
    })), [
        { sku: "NN95034", quantity: 6, kitParentSku: "NOMMM-FOUNDER-GIFT-3PK", kitQuantityPerParent: 2 },
        { sku: "NN95035", quantity: 6, kitParentSku: "NOMMM-FOUNDER-GIFT-3PK", kitQuantityPerParent: 2 },
        { sku: "NN95033", quantity: 6, kitParentSku: "NOMMM-FOUNDER-GIFT-3PK", kitQuantityPerParent: 2 }
    ]);
});

test("NomNom variety pack pick ticket lists physical component SKUs and quantities", () => {
    const parentSku = "NOMMM-SHOPIFY-50654262165696";
    const mapped = applyStoreSkuMappingsToPortalOrderPayload({
        lines: [{ sku: parentSku, quantity: 1 }]
    }, new Map([
        [parentSku, { localSku: parentSku, localQuantityMultiplier: 1 }]
    ]), new Map([
        [parentSku, [
            { componentSku: "NN95034", quantityPerParent: 2 },
            { componentSku: "NN95035", quantityPerParent: 2 },
            { componentSku: "NN95033", quantityPerParent: 1 },
            { componentSku: "NN79306", quantityPerParent: 1 },
            { componentSku: "NN10657", quantityPerParent: 1 },
            { componentSku: "NN18389", quantityPerParent: 1 }
        ]]
    ]));
    const lines = mapped.lines.map((line, index) => ({
        ...line,
        lineNumber: index + 1,
        trackingLevel: "UNIT",
        pickLocations: [{ location: `TEST-A0${index + 1}`, quantity: line.quantity, trackingLevel: "UNIT" }]
    }));
    const ticket = buildPortalOrderPickTicketLines({
        orderCode: "TEST-NOMMM-VARIETY",
        accountName: "CODEX PORTAL SYSTEM TEST",
        status: "RELEASED",
        poNumber: "TEST-PO",
        shippingReference: "TEST-REF",
        requestedShipDate: "2026-11-21",
        shipToName: "Test Receiver",
        shipToAddress1: "1 Test Road",
        shipToCity: "Toronto",
        shipToState: "ON",
        shipToPostalCode: "M1M 1M1",
        shipToCountry: "CA",
        lines
    }).join("\n");

    for (const [sku, quantity] of [["NN95034", 2], ["NN95035", 2], ["NN95033", 1],
        ["NN79306", 1], ["NN10657", 1], ["NN18389", 1]]) {
        assert.match(ticket, new RegExp(`${sku}\\s+${quantity} unit${quantity === 1 ? "" : "s"}`, "i"));
    }
    assert.doesNotMatch(ticket, new RegExp(parentSku));
});

test("kit component lookup is account scoped and rejects recursive or invalid rows", async () => {
    const calls = [];
    const lookup = await getItemKitComponentLookup({
        async query(sql, params) {
            calls.push({ sql: String(sql), params });
            return { rows: [
                { parent_sku: "KIT-1", component_sku: "SKU-A", quantity_per_parent: 2 },
                { parent_sku: "KIT-1", component_sku: "KIT-1", quantity_per_parent: 1 },
                { parent_sku: "KIT-1", component_sku: "SKU-B", quantity_per_parent: 0 }
            ] };
        }
    }, "COMPANY A", ["KIT-1", "KIT-1", ""]);

    assert.deepEqual(lookup.get("KIT-1"), [{ componentSku: "SKU-A", quantityPerParent: 2 }]);
    assert.deepEqual(calls[0].params, ["COMPANY A", ["KIT-1"]]);
    assert.match(calls[0].sql, /where account_name = \$1 and parent_sku = any\(\$2::text\[\]\)/);
});

test("store integration sync claims allow only one worker to own an integration", async () => {
    let activeToken = "";
    const client = {
        async query(sql, params) {
            assert.match(String(sql), /update store_integrations/);
            if (activeToken) return { rowCount: 0, rows: [] };
            activeToken = params[1];
            return { rowCount: 1, rows: [{ id: params[0], sync_claim_token: activeToken }] };
        }
    };

    const [first, second] = await Promise.all([
        claimStoreIntegrationSync(client, 42, { token: "worker-a" }),
        claimStoreIntegrationSync(client, 42, { token: "worker-b" })
    ]);

    assert.equal(first.token, "worker-a");
    assert.equal(second, null);
    assert.equal(STORE_INTEGRATION_SYNC_CLAIM_STALE_MINUTES, 30);
});

test("store integration sync claims are released only by their owner", async () => {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql: String(sql), params });
            return { rowCount: params[1] === "owner-token" ? 1 : 0, rows: [] };
        }
    };

    assert.equal(await releaseStoreIntegrationSyncClaim(client, 42, "other-token"), false);
    assert.equal(await releaseStoreIntegrationSyncClaim(client, 42, "owner-token"), true);
    assert.match(calls[0].sql, /sync_claim_token = \$2/);
});

test("external store order lock rechecks the import mapping after serialization", async () => {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql: String(sql), params });
            if (String(sql).includes("from store_order_imports")) {
                return { rowCount: 1, rows: [{ id: 7, portal_order_id: 99 }] };
            }
            return { rowCount: 1, rows: [{}] };
        }
    };

    const existing = await lockAndFindStoreOrderImport(client, 12, "shopify-1001");
    assert.deepEqual(existing, { id: 7, portal_order_id: 99 });
    assert.match(calls[0].sql, /pg_advisory_xact_lock/);
    assert.equal(calls[0].params[0], "store-order:12:shopify-1001");
    assert.match(calls[1].sql, /integration_id = \$1 and external_order_id = \$2/);
});

test("store order import records idempotency before attempting auto-release", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "server.js"), "utf8");
    const start = source.indexOf("async function importStoreOrdersForIntegration");
    const end = source.indexOf("async function fetchStoreOrdersForIntegration", start);
    const implementation = source.slice(start, end);
    assert.ok(implementation.indexOf("lockAndFindStoreOrderImport") < implementation.indexOf("savePortalOrderDraftForAccount"));
    assert.ok(implementation.indexOf("insert into store_order_imports") < implementation.indexOf("releaseWarehousePortalOrder"));
    assert.match(implementation, /on conflict \(integration_id, external_order_id\) do nothing/);
});

test("daily store integration sync runs at 9 AM in the WMS365 business timezone during daylight saving time", () => {
    assert.equal(STORE_INTEGRATION_SCHEDULE_TIME_ZONE, "America/New_York");
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_0900", { now: new Date("2026-06-12T12:30:00.000Z") }),
        "2026-06-12T13:00:00.000Z"
    );
});

test("daily store integration sync rolls to the next business day after the local run time passes", () => {
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_0900", { now: new Date("2026-06-12T13:05:00.000Z") }),
        "2026-06-13T13:00:00.000Z"
    );
});

test("daily store integration sync respects standard time offset", () => {
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_0900", { now: new Date("2026-01-10T13:30:00.000Z") }),
        "2026-01-10T14:00:00.000Z"
    );
});

test("weekday five-times schedule advances through all Eastern business-day slots", () => {
    const cases = [
        ["2026-06-15T09:00:00.000Z", "2026-06-15T10:00:00.000Z"],
        ["2026-06-15T10:01:00.000Z", "2026-06-15T12:30:00.000Z"],
        ["2026-06-15T12:31:00.000Z", "2026-06-15T15:00:00.000Z"],
        ["2026-06-15T15:01:00.000Z", "2026-06-15T17:30:00.000Z"],
        ["2026-06-15T17:31:00.000Z", "2026-06-15T20:00:00.000Z"]
    ];
    for (const [now, expected] of cases) {
        assert.equal(computeNextStoreIntegrationSyncAt("WEEKDAYS_5X_0600_1600", { now: new Date(now) }), expected);
    }
});

test("weekday five-times schedule skips weekends and respects standard time", () => {
    assert.equal(
        computeNextStoreIntegrationSyncAt("WEEKDAYS_5X_0600_1600", { now: new Date("2026-06-19T20:01:00.000Z") }),
        "2026-06-22T10:00:00.000Z"
    );
    assert.equal(
        computeNextStoreIntegrationSyncAt("WEEKDAYS_5X_0600_1600", { now: new Date("2026-01-05T10:00:00.000Z") }),
        "2026-01-05T11:00:00.000Z"
    );
});

test("daily three-times schedule advances through all Eastern slots including weekends", () => {
    const cases = [
        ["2026-10-25T10:00:00.000Z", "2026-10-25T11:30:00.000Z"],
        ["2026-10-25T11:31:00.000Z", "2026-10-25T15:30:00.000Z"],
        ["2026-10-25T15:31:00.000Z", "2026-10-25T18:30:00.000Z"],
        ["2026-10-25T18:31:00.000Z", "2026-10-26T11:30:00.000Z"]
    ];
    for (const [now, expected] of cases) {
        assert.equal(computeNextStoreIntegrationSyncAt("DAILY_3X_0730_1430", { now: new Date(now) }), expected);
    }
});

test("daily three-times schedule respects Eastern standard time", () => {
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_3X_0730_1430", { now: new Date("2026-12-12T11:00:00.000Z") }),
        "2026-12-12T12:30:00.000Z"
    );
});

test("Shopify settings support inventory-only sync lanes", () => {
    const settings = sanitizeStoreIntegrationSettingsInput("SHOPIFY", {
        shopify_location_id: "91373928677",
        primary_location_name: "Justeefy Canada",
        sync_orders: false,
        sync_shipment_confirmations: false,
        sync_inventory: true,
        inventory_disconnect_if_necessary: true
    });

    assert.deepEqual(settings, {
        shopifyLocationId: "91373928677",
        primaryLocationName: "Justeefy Canada",
        allowedShipCountries: [],
        syncOrders: false,
        syncShipmentConfirmations: false,
        syncInventory: true,
        notifyCustomerOnFulfillment: true,
        inventoryDisconnectIfNecessary: true
    });
});

test("Shopify settings preserve allowed ship-to country filters", () => {
    const settings = sanitizeStoreIntegrationSettingsInput("SHOPIFY", {
        allowed_ship_countries: ["Canada", "CA", "United States"]
    });

    assert.deepEqual(settings.allowedShipCountries, ["CA", "US"]);
});

test("Shopify location picker does not treat province letters inside a US city as Canada", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
    const start = source.indexOf("async function fetchShopifyLocationsForSelectedIntegration");
    const end = source.indexOf("async function loadAsyncJobs", start);
    const implementation = source.slice(start, end);

    assert.match(implementation, /country === "CANADA"/);
    assert.match(implementation, /\["ON", "ONTARIO", "QC", "QUEBEC"\]\.includes\(province\)/);
    assert.doesNotMatch(implementation, /\|on\/i/);
});

test("editing a Shopify connection preserves its allowed ship countries", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
    const start = source.indexOf("function buildIntegrationSettingsPayload");
    const end = source.indexOf("async function saveStoreIntegration", start);
    const implementation = source.slice(start, end);

    assert.match(implementation, /savedIntegration\?\.settings\?\.allowedShipCountries/);
    assert.match(implementation, /allowedShipCountries:/);
});

test("Shopify ship country guard accepts Canada and rejects non-Canada orders", () => {
    const settings = sanitizeStoreIntegrationSettingsInput("SHOPIFY", {
        allowedShipCountries: ["Canada"]
    });

    assert.equal(normalizeStoreOrderCountry("Canada"), "CA");
    assert.equal(normalizeStoreOrderCountry("CA"), "CA");
    assert.deepEqual(getShopifyOrderShipCountryDecision({
        shipping_address: { country: "Canada" }
    }, settings), {
        allowed: true,
        shipCountry: "CA",
        allowedShipCountries: ["CA"]
    });
    assert.deepEqual(getShopifyOrderShipCountryDecision({
        shipping_address: { country_code: "US" }
    }, settings), {
        allowed: false,
        shipCountry: "US",
        allowedShipCountries: ["CA"]
    });
    assert.deepEqual(getShopifyOrderShipCountryDecision({
        billing_address: { country_code: "CA" }
    }, settings), {
        allowed: false,
        shipCountry: "",
        allowedShipCountries: ["CA"]
    });
});

test("Shopify inventory export fails closed without location id", async () => {
    const summary = await exportShopifyInventoryLevels({}, {
        id: 1,
        account_name: "TRAVEONE LTD.",
        accountName: "TRAVEONE LTD.",
        provider: "SHOPIFY",
        settings: { syncInventory: true }
    });

    assert.equal(summary.exportedCount, 0);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.failedCount, 1);
    assert.match(summary.detailMessages[0], /location ID is required/);
});

test("Shopify inventory export fails closed without a company scope", async () => {
    const summary = await exportShopifyInventoryLevels({}, {
        id: 1,
        provider: "SHOPIFY",
        store_identifier: "packfire.myshopify.com",
        settings: {
            syncInventory: true,
            shopifyLocationId: "92461826304"
        }
    });

    assert.equal(summary.exportedCount, 0);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.failedCount, 1);
    assert.match(summary.detailMessages[0], /company scope is required/);
});

test("Shopify inventory export enforces tracked inventory and deny overselling", async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || "GET", body: options.body || "" });
        if (String(url).includes("/variants.json")) {
            return new Response(JSON.stringify({
                variants: [{
                    id: 111,
                    sku: "SKU-1",
                    inventory_item_id: 222,
                    inventory_management: null,
                    inventory_policy: "continue"
                }]
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("/variants/111.json")) {
            return new Response(JSON.stringify({ variant: { id: 111, inventory_management: "shopify", inventory_policy: "deny" } }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }
        if (String(url).includes("/inventory_levels/set.json")) {
            return new Response(JSON.stringify({ inventory_level: { inventory_item_id: 222, available: 7 } }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ errors: "unexpected request" }), { status: 500, headers: { "content-type": "application/json" } });
    };

    const queryLog = [];
    const client = {
        async query(sql, params = []) {
            queryLog.push({ sql: String(sql), params });
            if (String(sql).includes("with known_skus")) {
                return { rows: [{ sku: "SKU-1", on_hand_quantity: 10, available_quantity: 7 }], rowCount: 1 };
            }
            if (String(sql).includes("from store_sku_mappings")) {
                return { rows: [], rowCount: 0 };
            }
            if (String(sql).includes("from store_sync_exports")) {
                return { rows: [], rowCount: 0 };
            }
            if (String(sql).includes("insert into store_sync_exports")) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
        }
    };

    try {
        const summary = await exportShopifyInventoryLevels(client, {
            id: 9,
            account_name: "TEST COMPANY",
            provider: "SHOPIFY",
            store_identifier: "test-store.myshopify.com",
            access_token: "shpat_test",
            settings: {
                syncInventory: true,
                shopifyLocationId: "333"
            }
        });

        assert.equal(summary.exportedCount, 1);
        assert.equal(summary.failedCount, 0);

        const policyCall = calls.find((call) => call.url.includes("/variants/111.json"));
        assert.ok(policyCall, "variant policy update was sent");
        assert.equal(policyCall.method, "PUT");
        assert.deepEqual(JSON.parse(policyCall.body), {
            variant: {
                id: 111,
                inventory_management: "shopify",
                inventory_policy: "deny"
            }
        });

        const levelCall = calls.find((call) => call.url.includes("/inventory_levels/set.json"));
        assert.ok(levelCall, "inventory level update was sent");
        assert.deepEqual(JSON.parse(levelCall.body), {
            location_id: 333,
            inventory_item_id: 222,
            available: 7,
            disconnect_if_necessary: false
        });
    } finally {
        global.fetch = originalFetch;
    }
});

test("Shopify pack variants share one WMS inventory pool using mapping multipliers", async () => {
    const variants = [
        ["Ranchers1", 1],
        ["6-Pack", 6],
        ["12-Pack", 12],
        ["18-Pack", 18],
        ["RC-WS-5C", 60],
        ["RC-WS-10C", 120],
        ["RC-WS-63C", 756]
    ];
    const inventoryUpdates = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        if (String(url).includes("/variants.json")) {
            return new Response(JSON.stringify({
                variants: variants.map(([sku], index) => ({
                    id: 1000 + index,
                    sku,
                    inventory_item_id: 2000 + index,
                    inventory_management: "shopify",
                    inventory_policy: "deny"
                }))
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("/inventory_levels/set.json")) {
            inventoryUpdates.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ inventory_level: { available: inventoryUpdates.at(-1).available } }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ errors: "unexpected request" }), { status: 500, headers: { "content-type": "application/json" } });
    };

    const client = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("with known_skus")) {
                return { rows: [{ sku: "RTC-4OZ-12", on_hand_quantity: 2304, available_quantity: 2304 }], rowCount: 1 };
            }
            if (text.includes("from store_sku_mappings")) {
                return {
                    rows: variants.map(([externalSku, multiplier]) => ({
                        external_sku: externalSku,
                        local_sku: "RTC-4OZ-12",
                        local_quantity_multiplier: multiplier
                    })),
                    rowCount: variants.length
                };
            }
            if (text.includes("from item_kit_components")) return { rows: [], rowCount: 0 };
            if (text.includes("from store_sync_exports")) return { rows: [], rowCount: 0 };
            if (text.includes("insert into store_sync_exports")) return { rows: [], rowCount: 1 };
            throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
        }
    };

    try {
        const summary = await exportShopifyInventoryLevels(client, {
            id: 44,
            account_name: "TEST COMPANY",
            provider: "SHOPIFY",
            store_identifier: "test-store.myshopify.com",
            access_token: "shpat_test",
            settings: { syncInventory: true, shopifyLocationId: "333" }
        });

        assert.equal(summary.exportedCount, 7);
        assert.equal(summary.failedCount, 0);
        assert.deepEqual(inventoryUpdates.map((entry) => entry.available), [2304, 384, 192, 128, 38, 19, 3]);
    } finally {
        global.fetch = originalFetch;
    }
});

test("Shopify kit inventory is bounded by the scarcest component without parent stock", async () => {
    const inventoryUpdates = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        if (String(url).includes("/variants.json")) {
            return new Response(JSON.stringify({
                variants: [{
                    id: 8578951446720,
                    sku: "NOMMM-FOUNDER-GIFT-3PK",
                    inventory_item_id: 991,
                    inventory_management: "shopify",
                    inventory_policy: "deny"
                }]
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("/inventory_levels/set.json")) {
            inventoryUpdates.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ inventory_level: inventoryUpdates.at(-1) }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ errors: "unexpected request" }), { status: 500, headers: { "content-type": "application/json" } });
    };

    const componentAvailability = new Map([
        ["NN95034", 10],
        ["NN95035", 8],
        ["NN95033", 12]
    ]);
    const client = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("with known_skus")) {
                return {
                    rows: [...componentAvailability].map(([sku, available]) => ({
                        sku,
                        on_hand_quantity: available,
                        available_quantity: available
                    })),
                    rowCount: componentAvailability.size
                };
            }
            if (text.includes("from store_sku_mappings")) {
                return {
                    rows: [{
                        external_sku: "NOMMM-FOUNDER-GIFT-3PK",
                        local_sku: "NOMMM-FOUNDER-GIFT-3PK",
                        local_quantity_multiplier: 1
                    }],
                    rowCount: 1
                };
            }
            if (text.includes("from item_kit_components")) {
                return {
                    rows: [...componentAvailability.keys()].map((componentSku) => ({
                        parent_sku: "NOMMM-FOUNDER-GIFT-3PK",
                        component_sku: componentSku,
                        quantity_per_parent: 2
                    })),
                    rowCount: componentAvailability.size
                };
            }
            if (text.includes("from store_sync_exports")) return { rows: [], rowCount: 0 };
            if (text.includes("insert into store_sync_exports")) return { rows: [], rowCount: 1 };
            throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
        }
    };

    try {
        const summary = await exportShopifyInventoryLevels(client, {
            id: 45,
            account_name: "TEST COMPANY",
            provider: "SHOPIFY",
            store_identifier: "test-store.myshopify.com",
            access_token: "shpat_test",
            settings: { syncInventory: true, shopifyLocationId: "333" }
        });

        assert.equal(summary.exportedCount, 1);
        assert.equal(summary.failedCount, 0);
        assert.equal(inventoryUpdates.length, 1);
        assert.equal(inventoryUpdates[0].available, 4);
    } finally {
        global.fetch = originalFetch;
    }
});

test("Shopify inventory export still enforces oversell policy when quantity export is unchanged", async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || "GET", body: options.body || "" });
        if (String(url).includes("/variants.json")) {
            return new Response(JSON.stringify({
                variants: [{
                    id: 111,
                    sku: "SKU-1",
                    inventory_item_id: 222,
                    inventory_management: null,
                    inventory_policy: "continue"
                }]
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("/variants/111.json")) {
            return new Response(JSON.stringify({ variant: { id: 111, inventory_management: "shopify", inventory_policy: "deny" } }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }
        if (String(url).includes("/inventory_levels/set.json")) {
            return new Response(JSON.stringify({ inventory_level: { inventory_item_id: 222, available: 7 } }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ errors: "unexpected request" }), { status: 500, headers: { "content-type": "application/json" } });
    };

    const client = {
        async query(sql, params = []) {
            if (String(sql).includes("with known_skus")) {
                return { rows: [{ sku: "SKU-1", on_hand_quantity: 10, available_quantity: 7 }], rowCount: 1 };
            }
            if (String(sql).includes("from store_sku_mappings")) {
                return { rows: [], rowCount: 0 };
            }
            if (String(sql).includes("from store_sync_exports")) {
                return params[1] === "SHOPIFY_INVENTORY_LEVEL"
                    ? { rows: [{ "?column?": 1 }], rowCount: 1 }
                    : { rows: [], rowCount: 0 };
            }
            if (String(sql).includes("insert into store_sync_exports")) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
        }
    };

    try {
        const summary = await exportShopifyInventoryLevels(client, {
            id: 9,
            account_name: "TEST COMPANY",
            provider: "SHOPIFY",
            store_identifier: "test-store.myshopify.com",
            access_token: "shpat_test",
            settings: {
                syncInventory: true,
                shopifyLocationId: "333"
            }
        });

        assert.equal(summary.exportedCount, 0);
        assert.equal(summary.skippedCount, 1);
        assert.equal(summary.failedCount, 0);
        assert.ok(calls.find((call) => call.url.includes("/variants/111.json")), "variant policy update was sent even though quantity was skipped");
        assert.equal(calls.some((call) => call.url.includes("/inventory_levels/set.json")), false);
    } finally {
        global.fetch = originalFetch;
    }
});

test("secure integration credential request renders one-time noindex form", () => {
    const token = createIntegrationCredentialRequestToken();
    assert.ok(token.length >= 40);
    assert.equal(hashIntegrationCredentialRequestToken(token), hashIntegrationCredentialRequestToken(token));
    assert.notEqual(hashIntegrationCredentialRequestToken(token), token);

    const url = buildIntegrationCredentialRequestUrl(token);
    assert.match(url, /\/secure\/integration-credential\?token=/);

    const html = renderIntegrationCredentialRequestPage({
        token,
        request: {
            accountName: "TRAVEONE LTD.",
            provider: "SHOPIFY",
            integrationName: "Justeefy Shopify Inventory Sync",
            storeIdentifier: "fvapdw-08.myshopify.com",
            expiresAt: "2026-06-20T12:00:00.000Z",
            settings: {
                primaryLocationName: "Justeefy Canada",
                shopifyLocationId: "91373928677"
            }
        }
    });

    assert.match(html, /noindex,nofollow,noarchive,nosnippet/);
    assert.match(html, /Shopify Admin API access token/);
    assert.match(html, /TRAVEONE LTD\./);
    assert.match(html, /Justeefy Canada/);
    assert.match(html, /Test connection/);
    assert.match(html, /id="submit-button" type="submit" disabled/);
});

test("new secure Shopify connection asks the customer for the permanent store domain", () => {
    const html = renderIntegrationCredentialRequestPage({
        token: "preview-token",
        request: {
            accountName: "NOMMM CANADA INC.",
            provider: "SHOPIFY",
            integrationName: "NOMMM Shopify",
            storeIdentifier: "",
            expiresAt: "2026-11-08T12:00:00.000Z",
            settings: {}
        }
    });
    assert.match(html, /Permanent Shopify domain/);
    assert.match(html, /name="shopDomain"/);
    assert.match(html, /placeholder="store-name\.myshopify\.com"/);
    assert.doesNotMatch(html, /name="shopDomain"[^>]+readonly/);
    assert.match(html, /name="syncOrders"/);
    assert.match(html, /name="syncInventory"/);
    assert.match(html, /name="syncShipmentConfirmations"/);
    assert.match(html, /name="shopifyLocationId"/);
    assert.match(html, /name="syncSchedule"/);
    assert.match(html, /name="importStatus"/);
    assert.match(html, /name="allowedShipCountries"/);
});

test("secure integration credential input extracts a Shopify token from pasted JSON", () => {
    assert.equal(
        normalizeSubmittedIntegrationCredential('{"access_token":"shpat_example_token","scope":"read_products,write_inventory"}'),
        "shpat_example_token"
    );
    assert.equal(
        normalizeSubmittedIntegrationCredential("shpat_direct_token"),
        "shpat_direct_token"
    );
});

test("secure Shopify credential test verifies exact store and required scopes", async () => {
    const requiredScopes = String(SHOPIFY_APP_SCOPES).split(",").map((scope) => scope.trim()).filter(Boolean);
    const result = await testSubmittedShopifyCredential({
        provider: "SHOPIFY",
        storeIdentifier: "nommm-test.myshopify.com"
    }, "shpat_example_token_123456789", {
        fetchImpl: async (url, options) => {
            assert.match(String(url), /nommm-test\.myshopify\.com\/admin\/api\/.+\/graphql\.json/);
            assert.equal(options.headers["X-Shopify-Access-Token"], "shpat_example_token_123456789");
            return new Response(JSON.stringify({
                data: {
                    shop: { name: "NOMMM Test", myshopifyDomain: "nommm-test.myshopify.com" },
                    currentAppInstallation: { accessScopes: requiredScopes.map((handle) => ({ handle })) }
                }
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
    });
    assert.equal(result.shopDomain, "nommm-test.myshopify.com");
    assert.deepEqual(result.verifiedPermissions, requiredScopes);
});

test("secure Shopify credential test rejects a token for another store", async () => {
    await assert.rejects(
        testSubmittedShopifyCredential({
            provider: "SHOPIFY",
            storeIdentifier: "nommm-test.myshopify.com"
        }, "shpat_example_token_123456789", {
            fetchImpl: async () => new Response(JSON.stringify({
                data: {
                    shop: { name: "Wrong Store", myshopifyDomain: "wrong-store.myshopify.com" },
                    currentAppInstallation: { accessScopes: [] }
                }
            }), { status: 200, headers: { "content-type": "application/json" } })
        }),
        /token belongs to wrong-store\.myshopify\.com/
    );
});

test("secure Shopify credential test rejects changing a preconfigured store", async () => {
    await assert.rejects(
        testSubmittedShopifyCredential({
            provider: "SHOPIFY",
            storeIdentifier: "locked-store.myshopify.com"
        }, "shpat_example_token_123456789", {
            shopDomain: "another-store.myshopify.com",
            fetchImpl: async () => {
                throw new Error("Shopify should not be called for a mismatched locked store.");
            }
        }),
        /secure link is locked to locked-store\.myshopify\.com/
    );
});

test("secure Shopify credential test reports missing required permissions", async () => {
    await assert.rejects(
        testSubmittedShopifyCredential({
            provider: "SHOPIFY",
            storeIdentifier: "nommm-test.myshopify.com"
        }, "shpat_example_token_123456789", {
            fetchImpl: async () => new Response(JSON.stringify({
                data: {
                    shop: { name: "NOMMM Test", myshopifyDomain: "nommm-test.myshopify.com" },
                    currentAppInstallation: { accessScopes: [{ handle: "read_products" }] }
                }
            }), { status: 200, headers: { "content-type": "application/json" } })
        }),
        /missing required permissions:.*read_orders/
    );
});

test("secure Shopify self-service configuration saves verified sync choices", () => {
    const configuration = normalizeSecureShopifyConfiguration({
        syncOrders: "on",
        syncInventory: "on",
        syncShipmentConfirmations: "on",
        notifyCustomerOnFulfillment: "on",
        shopifyLocationId: "12345",
        allowedShipCountries: "CA,US",
        syncSchedule: "EVERY_15_MINUTES",
        importStatus: "DRAFT"
    }, { settings: {}, syncSchedule: "MANUAL", importStatus: "DRAFT" }, {
        locations: [{ id: "12345", name: "Grey Wolf Fulfillment", active: true }]
    });
    assert.equal(configuration.syncSchedule, "EVERY_15_MINUTES");
    assert.equal(configuration.importStatus, "DRAFT");
    assert.equal(configuration.settings.syncOrders, true);
    assert.equal(configuration.settings.syncInventory, true);
    assert.equal(configuration.settings.syncShipmentConfirmations, true);
    assert.equal(configuration.settings.shopifyLocationId, "12345");
    assert.equal(configuration.settings.primaryLocationName, "Grey Wolf Fulfillment");
    assert.deepEqual(configuration.settings.allowedShipCountries, ["CA", "US"]);
});

test("secure Shopify self-service blocks stock sync without a verified location", () => {
    assert.throws(() => normalizeSecureShopifyConfiguration({
        syncInventory: "on",
        shopifyLocationId: "unverified"
    }, { settings: {}, syncSchedule: "MANUAL", importStatus: "DRAFT" }, { locations: [] }), /verified Shopify location/);
});

test("Shopify OAuth HMAC verification sorts query parameters and ignores hmac", () => {
    const secret = "test-shopify-secret";
    const query = {
        shop: "packfire.myshopify.com",
        timestamp: "1783021519",
        accountName: "PACKFIRE"
    };
    const message = buildShopifyHmacMessage(query);
    const hmac = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");

    assert.equal(message, "accountName=PACKFIRE&shop=packfire.myshopify.com&timestamp=1783021519");
    assert.equal(verifyShopifyRequestHmac({ ...query, hmac }, secret), true);
    assert.equal(verifyShopifyRequestHmac({ ...query, hmac: `${hmac.slice(0, -1)}0` }, secret), false);
});

test("Shopify OAuth state is signed, scoped to company, and rejects tampering", () => {
    const secret = "state-secret";
    const state = signShopifyOAuthState({
        accountName: "Pack Fire",
        integrationId: 12,
        shop: "PackFire.myshopify.com"
    }, secret);
    const payload = verifyShopifyOAuthState(state, secret);

    assert.equal(payload.accountName, "PACK FIRE");
    assert.equal(payload.integrationId, 12);
    assert.equal(payload.shop, "packfire.myshopify.com");
    assert.throws(() => verifyShopifyOAuthState(`${state.slice(0, -1)}x`, secret), /could not be verified|missing or invalid/);
    assert.throws(
        () => signShopifyOAuthState({ accountName: "Pack Fire", shop: "not-shopify.example" }, secret),
        /valid \.myshopify\.com store/
    );
});

test("Shopify shop domains normalize to safe myshopify host names only", () => {
    assert.equal(normalizeShopifyShopDomain("https://PackFire.myshopify.com/admin"), "packfire.myshopify.com");
    assert.equal(normalizeShopifyShopDomain("packfire.com"), "");
    assert.equal(normalizeShopifyShopDomain("https://evil.myshopify.com.evil.com"), "");
});
