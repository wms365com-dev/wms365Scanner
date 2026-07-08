const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
    STORE_INTEGRATION_SCHEDULE_TIME_ZONE,
    computeNextStoreIntegrationSyncAt,
    sanitizeStoreIntegrationSettingsInput,
    exportShopifyInventoryLevels,
    createIntegrationCredentialRequestToken,
    hashIntegrationCredentialRequestToken,
    buildIntegrationCredentialRequestUrl,
    renderIntegrationCredentialRequestPage,
    normalizeSubmittedIntegrationCredential,
    normalizeShopifyShopDomain,
    buildShopifyHmacMessage,
    verifyShopifyRequestHmac,
    signShopifyOAuthState,
    verifyShopifyOAuthState
} = require("./server");

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
        syncOrders: false,
        syncShipmentConfirmations: false,
        syncInventory: true,
        notifyCustomerOnFulfillment: true,
        inventoryDisconnectIfNecessary: true
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
    const state = signShopifyOAuthState({ accountName: "Pack Fire", integrationId: 12 }, secret);
    const payload = verifyShopifyOAuthState(state, secret);

    assert.equal(payload.accountName, "PACK FIRE");
    assert.equal(payload.integrationId, 12);
    assert.throws(() => verifyShopifyOAuthState(`${state.slice(0, -1)}x`, secret), /could not be verified|missing or invalid/);
});

test("Shopify shop domains normalize to safe myshopify host names only", () => {
    assert.equal(normalizeShopifyShopDomain("https://PackFire.myshopify.com/admin"), "packfire.myshopify.com");
    assert.equal(normalizeShopifyShopDomain("packfire.com"), "");
    assert.equal(normalizeShopifyShopDomain("https://evil.myshopify.com.evil.com"), "");
});
