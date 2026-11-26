const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = __dirname;
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const mobileSource = fs.readFileSync(path.join(root, "mobile-pick.html"), "utf8");

test("grouped pallet allocations only accept matching, pickable, uncommitted stock", async () => {
    const start = serverSource.indexOf("async function reallocatePortalOrderToActualPalletLocations(");
    const end = serverSource.indexOf("async function updateAdminPortalOrderStatus(", start);
    const normalizeText = (value) => String(value ?? "").trim().toUpperCase();
    const pick = vm.runInNewContext(`(${serverSource.slice(start, end).trim()})`, {
        normalizeText, toPositiveInt: Number, httpError: (_, message) => Error(message),
        resolveFulfillmentLocationForWarehouseRule: async () => ({ id: 1 }),
        assertWarehouseLocationIsolation: async (_, { location }) => assert.equal(location, "BULK"),
        ACTIVE_PORTAL_ORDER_STATUSES: ["RELEASED"],
        NON_PICKABLE_LOCATION_TYPES: new Set(["RECEIVING"]),
        normalizeDateOnly: () => "",
        sortInventoryRowsForAllocation: (rows) => rows
    });
    const order = { id: 1, accountName: "TEST COMPANY", fulfillmentLocationId: 1 };
    const pallets = Array.from({ length: 4 }, () => ({ location: "BULK" }));
    const client = ({ pickable = true, committed = 0, inventoryId = 42 } = {}) => ({
        async query(sql) {
            if (sql.includes("for update of a")) return { rows: [{
                sku: "SKU", location: "BULK", inventory_line_id: 42,
                allocated_quantity: 4, inventory_tracking_level: "PALLET"
            }] };
            if (sql.includes("for update of i")) return { rows: [{
                id: inventoryId, location: "BULK", quantity: 4, bin_is_pickable: pickable,
                bin_account_name: "TEST COMPANY", bin_fulfillment_location_id: 1
            }] };
            if (sql.includes("group by a.inventory_line_id")) return { rows: [
                { inventory_line_id: 42, allocated_quantity: committed }
            ] };
            assert.fail("A matching bulk pick must not rewrite allocations or stock");
        }
    });
    assert.equal((await pick(client(), order, pallets)).length, 0);
    await assert.rejects(pick(client(), order, pallets.slice(1)), /pallet count/);
    await assert.rejects(pick(client(), order, [...pallets.slice(1), { location: "OTHER" }]), /pallet count/);
    await assert.rejects(pick(client({ pickable: false }), order, pallets), /not pickable/);
    await assert.rejects(pick(client({ committed: 1 }), order, pallets), /uncommitted pallet/);
    await assert.rejects(pick(client({ inventoryId: 43 }), order, pallets), /uncommitted pallet/);
});

test("Alcona picked status requires pallet-level location and weight", () => {
    assert.match(serverSource, /Enter every picked pallet's actual bin and weight/);
    assert.match(serverSource, /reallocatePortalOrderToActualPalletLocations/);
    assert.match(serverSource, /PORTAL_ORDER_PALLET_REALLOCATION/);
    assert.match(serverSource, /does not have one uncommitted pallet/);
    assert.match(serverSource, /Actual pick bin/);
    assert.match(serverSource, /picked_pallet_details = \$3::jsonb/);
    assert.match(serverSource, /outbound_total_pallets = case[\s\S]*jsonb_array_length\(\$3::jsonb\)/);
});

test("actual pallet-bin substitutions preserve customer, warehouse, and pickable-stock boundaries", () => {
    assert.match(serverSource, /where i\.account_name = \$1[\s\S]*and i\.sku = \$2[\s\S]*upper\(i\.location\) = any\(\$3::text\[\]\)/);
    assert.match(serverSource, /assertWarehouseLocationIsolation\(client, \{[\s\S]*purpose: "Actual pick bin"/);
    assert.match(serverSource, /row\.bin_is_pickable !== true/);
    assert.match(serverSource, /row\.bin_account_name/);
    assert.match(serverSource, /row\.bin_fulfillment_location_id/);
    assert.match(serverSource, /a\.order_id <> \$2/);
});

test("desktop and mobile picking collect pallet-level evidence", () => {
    assert.match(desktopSource, /data-picked-pallet-location/);
    assert.match(desktopSource, /data-picked-pallet-weight/);
    assert.match(mobileSource, /data-mobile-pallet-location/);
    assert.match(mobileSource, /data-mobile-pallet-weight/);
});
