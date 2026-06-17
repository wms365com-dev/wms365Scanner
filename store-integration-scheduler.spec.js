const test = require("node:test");
const assert = require("node:assert/strict");

const {
    STORE_INTEGRATION_SCHEDULE_TIME_ZONE,
    computeNextStoreIntegrationSyncAt,
    sanitizeStoreIntegrationSettingsInput,
    exportShopifyInventoryLevels
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
