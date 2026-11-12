"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPartialFulfillmentLines } = require("./shopify-partial-fulfillment");

const order = { lines: [{ id: 11, sku: "LOCAL-A", quantity: 12 }],
    shipmentLines: [{ orderLineId: 11, shippedQuantity: 12 }] };
const shopifyLines = [{ id: 101, sku: "EXT-A" }, { id: 102, sku: "EXT-B" }];
const mappings = [{ external_sku: "EXT-A", local_sku: "LOCAL-A", local_quantity_multiplier: 2 }];
const fulfillmentOrders = [{ id: 201, status: "OPEN", line_items: [
    { id: 301, line_item_id: 101, fulfillable_quantity: 6 },
    { id: 302, line_item_id: 102, fulfillable_quantity: 4 }
] }];

test("fulfills only the shipped WMS line with converted quantity", () => {
    assert.deepEqual(buildPartialFulfillmentLines(order, fulfillmentOrders, shopifyLines, mappings), [
        { fulfillment_order_id: 201, fulfillment_order_line_items: [{ id: 301, quantity: 6 }] }
    ]);
});

test("refuses short Shopify balance and does not include an unrelated line", () => {
    assert.throws(() => buildPartialFulfillmentLines(order,
        [{ ...fulfillmentOrders[0], line_items: [{ id: 301, line_item_id: 101, fulfillable_quantity: 5 }] }],
        shopifyLines, mappings), /enough open quantity/);
});

test("refuses ambiguous Shopify SKU mapping", () => {
    assert.throws(() => buildPartialFulfillmentLines(order, fulfillmentOrders,
        [...shopifyLines, { id: 103, sku: "EXT-A" }], mappings), /ambiguous/);
});

test("refuses unconfirmed quantities and nondivisible conversion", () => {
    assert.throws(() => buildPartialFulfillmentLines({ ...order, shipmentLines: [] },
        fulfillmentOrders, shopifyLines, mappings), /confirmed/);
    assert.throws(() => buildPartialFulfillmentLines({ ...order,
        shipmentLines: [{ orderLineId: 11, shippedQuantity: 11 }] },
        fulfillmentOrders, shopifyLines, mappings), /indivisible/);
});
