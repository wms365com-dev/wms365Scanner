"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${name} must exist`);
    const bodyStart = source.indexOf(") {", start) + 2;
    assert.ok(bodyStart > 1, `${name} body must exist`);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${name} is incomplete`);
}

const getPortalOrderShipToFieldsSource = extractFunction(warehouse, "getPortalOrderShipToFields");
const formatSalesOrderListShipTo = Function(
    `"use strict"; ${getPortalOrderShipToFieldsSource}; ${extractFunction(warehouse, "formatSalesOrderListShipTo")}; return formatSalesOrderListShipTo;`
)();
const formatPortalOrderShipTo = Function(
    `"use strict"; ${getPortalOrderShipToFieldsSource}; ${extractFunction(warehouse, "formatPortalOrderShipTo")}; return formatPortalOrderShipTo;`
)();
const sanitizePortalOrderDestination = Function(
    `"use strict"; ${extractFunction(warehouse, "sanitizePortalOrderDestination")}; return sanitizePortalOrderDestination;`
)();
const sanitizePortalOrderRecord = Function(
    `"use strict";
     const norm = (value) => String(value || "").trim().toUpperCase();
     const normalizeShipmentMethod = (value) => String(value || "").trim().toUpperCase();
     const sanitizePortalOrderPrintSummary = () => ({});
     ${extractFunction(warehouse, "sanitizePortalOrderDestination")};
     ${extractFunction(warehouse, "sanitizePortalOrderRecord")};
     return sanitizePortalOrderRecord;`
)();

test("sales-order list displays a compact permission-scoped ship-to destination", () => {
    assert.match(warehouse, /function formatSalesOrderListShipTo\(order\)/);
    assert.match(warehouse, /<th>Ship To<\/th>/);
    assert.match(warehouse, /shipTo\.primary/);
    assert.match(warehouse, /shipTo\.secondary/);
    assert.match(warehouse, /function getPortalOrderShipToFields\(order = \{\}\)/);
    assert.match(warehouse, /primary: shipTo\.name \|\| "Ship-to not set"/);
    assert.match(warehouse, /shipTo\.city, shipTo\.state/);
});

test("released-order list and detail use the same receiver fallback", () => {
    const releasedOrder = sanitizePortalOrderRecord({
        id: 2314,
        orderCode: "ORD-002314",
        accountName: "TEST COMPANY",
        status: "RELEASED",
        shipmentMethod: "LTL_FREIGHT",
        ship_to_name: "",
        contact_name: "Receiving Desk",
        ship_to_address1: "100 Test Avenue",
        ship_to_city: "Mississauga",
        ship_to_state: "ON",
        ship_to_postal_code: "L5T 1A1",
        ship_to_country: "Canada"
    });
    assert.deepEqual(formatSalesOrderListShipTo(releasedOrder), {
        primary: "Receiving Desk",
        secondary: "Mississauga, ON"
    });
    assert.match(formatPortalOrderShipTo(releasedOrder), /^Receiving Desk<br>/);
    assert.match(formatPortalOrderShipTo(releasedOrder), /100 Test Avenue<br>Mississauga, ON, L5T 1A1<br>Canada$/);
    assert.match(warehouse, /const shipTo = getPortalOrderShipToFields\(order\);\s+ui\.warehouseOrderContactName\.value = shipTo\.contactName;/);
    assert.match(warehouse, /ui\.warehouseOrderShipToName\.value = shipTo\.name;/);
});

test("customer pickup is identified without fabricating a delivery address", () => {
    assert.match(warehouse, /shipmentMethod \|\| ""\)\.toUpperCase\(\) === "CUSTOMER_PICKUP"/);
    assert.match(warehouse, /primary: "Customer pickup"/);
    assert.match(warehouse, /order\.fulfillmentLocationName \|\| order\.fulfillmentLocationCode \|\| "Assigned warehouse"/);
    const pickup = sanitizePortalOrderRecord({
        id: 2315,
        orderCode: "ORD-002315",
        accountName: "TEST COMPANY",
        status: "RELEASED",
        shipmentMethod: "CUSTOMER_PICKUP",
        fulfillment_location_id: 143,
        fulfillment_location_code: "GW3PL-MISS",
        fulfillment_location_name: "Grey Wolf Mississauga"
    });
    assert.deepEqual(formatSalesOrderListShipTo(pickup), {
        primary: "Customer pickup",
        secondary: "Grey Wolf Mississauga"
    });
    assert.equal(pickup.fulfillmentLocationId, "143");
    assert.equal(pickup.fulfillmentLocationCode, "GW3PL-MISS");
    assert.match(server, /fl\.code as fulfillment_location_code/);
    assert.match(server, /fl\.name as fulfillment_location_name/);
    assert.match(server, /left join fulfillment_locations fl\s+on fl\.id = o\.fulfillment_location_id/);
});

test("ship-to visibility reuses the existing scoped order response", () => {
    assert.match(warehouse, /const request = requestJson\(`\/api\/admin\/portal-orders\$\{query\}`\)/);
    assert.match(server, /app\.get\("\/api\/admin\/portal-orders"/);
    assert.match(server, /async function assertAppUserCompanyAccess\(/);
    assert.match(server, /async function assertAppUserPortalOrderWarehouseAccess\(/);
    assert.doesNotMatch(warehouse, /requestJson\([^\n]*ship-to-list/);
});
