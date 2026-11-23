"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const verifier = fs.readFileSync(path.join(__dirname, "scripts", "verify-test-company-sales-order-allocation-preview.js"), "utf8");

function functionSource(name, nextName) {
    const start = desktop.indexOf(`function ${name}(`);
    const end = desktop.indexOf(`function ${nextName}(`, start + 1);
    assert.ok(start >= 0 && end > start, `${name} source was not found`);
    return desktop.slice(start, end);
}

function buildInventoryChoices({ inventory, orders = [], assignments, activeWarehouseId = "1" }) {
    const source = functionSource("getWarehouseSalesOrderInventoryChoices", "getWarehouseSalesOrderSelectableItems");
    const factory = new Function(
        "norm",
        "getActiveWarehouseAssignment",
        "getCompanyFulfillmentAssignments",
        "portalOrderRecords",
        "state",
        "getLineDescription",
        "normalizeTrackingLevel",
        `${source}; return getWarehouseSalesOrderInventoryChoices;`
    );
    const norm = (value) => String(value || "").trim().toUpperCase();
    return factory(
        norm,
        () => assignments.find((entry) => String(entry.fulfillmentLocationId) === String(activeWarehouseId)),
        () => assignments,
        orders,
        { inventory },
        (line) => String(line?.description || ""),
        (value) => String(value || "UNIT").toUpperCase()
    )("CODEX PORTAL SYSTEM TEST");
}

test("draft allocation preview consumes authoritative inventory availability once", () => {
    const source = functionSource("getWarehouseSalesOrderInventoryChoices", "getWarehouseSalesOrderSelectableItems");
    assert.match(source, /existing\.availableQuantity \+= Number\(line\.availableQuantity\) \|\| 0/);
    assert.match(source, /existing\.reservedQuantity = \(existing\.reservedQuantity \|\| 0\) \+ \(Number\(line\.reservedQuantity\) \|\| 0\)/);
    assert.match(source, /unallocatedQuantity = Math\.max\([\s\S]*?line\.quantity[\s\S]*?- \(Number\(line\.allocatedQuantity\) \|\| 0\)/);
    assert.match(source, /availableQuantity: Math\.max\(item\.availableQuantity - unallocatedLegacyReserve, 0\)/);
    assert.doesNotMatch(source, /item\.onHandQuantity - reservedQuantity/);
});

test("draft allocation preview is scoped to the active warehouse and its configured inventory pool", () => {
    const source = functionSource("getWarehouseSalesOrderInventoryChoices", "getWarehouseSalesOrderSelectableItems");
    assert.match(source, /const activeWarehouse = getActiveWarehouseAssignment\(\)/);
    assert.match(source, /assignment\.portalInventoryRollupLocationId/);
    assert.match(source, /location === code \|\| location\.startsWith\(`\$\{code\}-`\)/);
    assert.match(source, /reservationScopeIds\.has\(String\(order\.fulfillmentLocationId\)\)/);
    assert.match(source, /if \(activeWarehouseId && !inventoryLineIsInScope\(line\)\) return/);
});

test("warehouse inventory-pool configuration reaches the browser state", () => {
    assert.match(server, /portalInventoryRollupLocationId: row\.portal_inventory_rollup_location_id == null/);
    assert.match(desktop, /portalInventoryRollupLocationId: String\(item\?\.portalInventoryRollupLocationId \|\| item\?\.portal_inventory_rollup_location_id/);
});

test("allocated stock is not deducted twice and other warehouses stay excluded", () => {
    const assignments = [
        { fulfillmentLocationId: "1", locationCode: "TEST-WMS-A" },
        { fulfillmentLocationId: "2", locationCode: "TEST-WMS-B" },
        { fulfillmentLocationId: "3", locationCode: "TEST-POOL", portalInventoryRollupLocationId: "1" }
    ];
    const inventory = [
        { accountName: "CODEX PORTAL SYSTEM TEST", location: "TEST-WMS-A-01", sku: "TEST-SKU", quantity: 2, onHandQuantity: 2, reservedQuantity: 1, availableQuantity: 1 },
        { accountName: "CODEX PORTAL SYSTEM TEST", location: "TEST-POOL-01", sku: "TEST-SKU", quantity: 1, onHandQuantity: 1, reservedQuantity: 0, availableQuantity: 1 },
        { accountName: "CODEX PORTAL SYSTEM TEST", location: "TEST-WMS-B-01", sku: "TEST-SKU", quantity: 20, onHandQuantity: 20, reservedQuantity: 0, availableQuantity: 20 }
    ];
    const orders = [{
        id: "allocated-order",
        accountName: "CODEX PORTAL SYSTEM TEST",
        fulfillmentLocationId: "1",
        status: "RELEASED",
        lines: [{ sku: "TEST-SKU", quantity: 1, allocatedQuantity: 1 }]
    }];

    const [choice] = buildInventoryChoices({ inventory, orders, assignments });
    assert.equal(choice.onHandQuantity, 3);
    assert.equal(choice.reservedQuantity, 1);
    assert.equal(choice.availableQuantity, 2);
    assert.deepEqual(choice.locations, ["TEST-POOL-01", "TEST-WMS-A-01"]);
});

test("only an active order's unallocated legacy remainder reduces the preview", () => {
    const assignments = [{ fulfillmentLocationId: "1", locationCode: "TEST-WMS-A" }];
    const inventory = [{
        accountName: "CODEX PORTAL SYSTEM TEST",
        location: "TEST-WMS-A-01",
        sku: "TEST-SKU",
        quantity: 2,
        onHandQuantity: 2,
        reservedQuantity: 0,
        availableQuantity: 2
    }];
    const orders = [
        { id: "legacy", accountName: "CODEX PORTAL SYSTEM TEST", fulfillmentLocationId: "1", status: "RELEASED", lines: [{ sku: "TEST-SKU", quantity: 1, allocatedQuantity: 0 }] },
        { id: "other-warehouse", accountName: "CODEX PORTAL SYSTEM TEST", fulfillmentLocationId: "2", status: "RELEASED", lines: [{ sku: "TEST-SKU", quantity: 1, allocatedQuantity: 0 }] }
    ];

    const [choice] = buildInventoryChoices({ inventory, orders, assignments });
    assert.equal(choice.onHandQuantity, 2);
    assert.equal(choice.reservedQuantity, 1);
    assert.equal(choice.availableQuantity, 1);
});

test("sandbox verifier is designated-company pinned, warehouse-negative, and rollback-only", () => {
    assert.match(verifier, /requireDesignatedTestCompany\(client\)/);
    assert.match(verifier, /quantity: 2/);
    assert.match(verifier, /quantity: 20/);
    assert.match(verifier, /selectedWarehouseLine\.reserved_quantity\) !== 1/);
    assert.match(verifier, /otherWarehouseLine\.available_quantity\) !== 20/);
    assert.match(verifier, /allocations\.rows\[0\]\.location !== `\$\{warehouseCodes\[0\]\}-A01`/);
    assert.match(verifier, /await client\.query\("rollback"\)/);
    assert.doesNotMatch(verifier, /client\.query\(["']commit|sendSystemEmail|NODE_ENV[^\n]*production/i);
});
