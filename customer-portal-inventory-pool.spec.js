const test = require("node:test");
const assert = require("node:assert/strict");

const {
    aggregatePortalInventoryWarehouseAvailability,
    buildPortalOrderInternalTransferSummary,
    buildPortalOrderSplitFulfillmentGroups,
    getPortalFulfillmentLocationsForAccount,
    getPortalInventoryPoolSources,
    resolvePortalFulfillmentLocation
} = require("./server.js");

test("portal warehouse list excludes internal-only warehouse assignments", async () => {
    let sql = "";
    const client = {
        query: async (query) => {
            sql = query;
            return {
                rows: [{
                    assignment_id: 1,
                    fulfillment_location_id: 1,
                    account_name: "TEST COMPANY",
                    code: "TEST-MISS",
                    name: "Test Main Warehouse",
                    customer_portal_visible: true,
                    is_active: true,
                    allow_outbound: true
                }]
            };
        }
    };

    const locations = await getPortalFulfillmentLocationsForAccount(client, "TEST COMPANY");
    assert.equal(locations.length, 1);
    assert.equal(locations[0].id, "1");
    assert.equal(locations[0].locationCode, "TEST-MISS");
    assert.match(sql, /cfl\.customer_portal_visible = true/);
    await assert.rejects(
        () => resolvePortalFulfillmentLocation(client, "TEST COMPANY", { fulfillmentLocationId: 2 }),
        (error) => error.statusCode === 400 && /assigned to this company/i.test(error.message)
    );
});

test("portal inventory combines physical sources under the customer-visible warehouse", () => {
    const availability = aggregatePortalInventoryWarehouseAvailability([
        {
            sku: "SKU-1",
            fulfillment_location_id: 1,
            portal_fulfillment_location_id: 1,
            portal_location_code: "TEST-MISS",
            portal_location_name: "Test Main Warehouse",
            on_hand_quantity: 5,
            reserved_quantity: 2,
            location_count: 1,
            locations: ["TEST-MISS-A01"]
        },
        {
            sku: "SKU-1",
            fulfillment_location_id: 2,
            portal_fulfillment_location_id: 1,
            portal_location_code: "TEST-MISS",
            portal_location_name: "Test Main Warehouse",
            on_hand_quantity: 10,
            reserved_quantity: 1,
            location_count: 1,
            locations: ["TEST-EDW-A01"]
        }
    ]);

    assert.deepEqual(availability, [{
        sku: "SKU-1",
        fulfillmentLocationId: "1",
        locationCode: "TEST-MISS",
        locationName: "Test Main Warehouse",
        onHandQuantity: 15,
        reservedQuantity: 3,
        availableQuantity: 12,
        locationCount: 2,
        locations: ["TEST-MISS-A01"],
        pooledInventory: true,
        internalTransferAvailableQuantity: 10
    }]);
});

test("inventory-pool lookup is account scoped and prefers the order warehouse", async () => {
    let capturedParams = [];
    const client = {
        query: async (sql, params) => {
            capturedParams = params;
            assert.match(sql, /cfl\.account_name = \$1/);
            assert.match(sql, /cfl\.portal_inventory_rollup_location_id = \$2/);
            return {
                rows: [
                    { fulfillment_location_id: 1, code: "TEST-MISS", requires_internal_transfer: false },
                    { fulfillment_location_id: 2, code: "TEST-EDW", requires_internal_transfer: true }
                ]
            };
        }
    };
    const sources = await getPortalInventoryPoolSources(client, "TEST COMPANY", 1);
    assert.deepEqual(capturedParams, ["TEST COMPANY", 1]);
    assert.deepEqual(sources.map((source) => source.fulfillment_location_id), [1, 2]);
});

test("pooled allocations create one customer shipment and an internal transfer summary", () => {
    const order = {
        id: "10",
        orderCode: "TEST-ORDER-POOL",
        accountName: "TEST COMPANY",
        portalInventoryPoolEnabled: true,
        fulfillmentLocationId: "1",
        fulfillmentLocationCode: "TEST-MISS",
        fulfillmentLocationName: "Test Main Warehouse",
        lines: [{
            id: "20",
            sku: "SKU-1",
            quantity: 12,
            trackingLevel: "CASE",
            pickLocations: [
                {
                    fulfillmentLocationId: "1",
                    fulfillmentLocationCode: "TEST-MISS",
                    fulfillmentLocationName: "Test Main Warehouse",
                    location: "TEST-MISS-A01",
                    quantity: 5
                },
                {
                    fulfillmentLocationId: "2",
                    fulfillmentLocationCode: "TEST-EDW",
                    fulfillmentLocationName: "Test Edwards Warehouse",
                    location: "TEST-EDW-A01",
                    quantity: 7
                }
            ]
        }]
    };

    const groups = buildPortalOrderSplitFulfillmentGroups(order);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].location.id, "1");
    assert.equal(groups[0].totalQuantity, 12);

    const transfer = buildPortalOrderInternalTransferSummary(order);
    assert.equal(transfer.required, true);
    assert.equal(transfer.totalQuantity, 7);
    assert.deepEqual(transfer.sourceFulfillmentLocationIds, ["2"]);
    assert.deepEqual(transfer.lines[0].sourceLocations, ["TEST-EDW-A01"]);
});

test("non-pooled multi-warehouse allocations remain split", () => {
    const order = {
        id: "11",
        orderCode: "TEST-ORDER-SPLIT",
        accountName: "TEST COMPANY",
        portalInventoryPoolEnabled: false,
        fulfillmentLocationId: "1",
        lines: [{
            id: "21",
            sku: "SKU-1",
            quantity: 12,
            pickLocations: [
                { fulfillmentLocationId: "1", fulfillmentLocationCode: "TEST-MISS", quantity: 5 },
                { fulfillmentLocationId: "2", fulfillmentLocationCode: "TEST-EDW", quantity: 7 }
            ]
        }]
    };
    assert.equal(buildPortalOrderSplitFulfillmentGroups(order).length, 2);
    assert.equal(buildPortalOrderInternalTransferSummary(order).required, false);
});
