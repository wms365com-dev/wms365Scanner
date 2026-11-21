const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = source.indexOf("\n        function ", start + 1);
    const nextAsync = source.indexOf("\n        async function ", start + 1);
    return source.slice(start, Math.min(...[next, nextAsync].filter((value) => value > start)));
}

function buildSorter() {
    const script = `${functionSource("getShippedOrderSortValue")}\n${functionSource("sortPortalOrdersForView")}\nsortPortalOrdersForView;`;
    return vm.runInNewContext(script, {
        shippedOrdersSortKey: "shippedAt",
        shippedOrdersSortDirection: "desc",
        formatSalesOrderListShipTo: (order) => ({ primary: order.shipToName || "" })
    });
}

test("shipped orders default to newest shipment first with stable order-code ties", () => {
    const sort = buildSorter();
    const orders = [
        { id: 1, orderCode: "ORD-10", shippedAt: "2026-11-19T12:00:00Z" },
        { id: 2, orderCode: "ORD-2", shippedAt: "2026-11-20T12:00:00Z" },
        { id: 3, orderCode: "ORD-1", shippedAt: "2026-11-20T12:00:00Z" }
    ];
    assert.deepEqual(Array.from(sort(orders, true), (order) => order.id), [3, 2, 1]);
    assert.deepEqual(orders.map((order) => order.id), [1, 2, 3], "source order must remain unchanged");
});

test("sorting can reverse and does not change the live sales-order queue", () => {
    const sort = buildSorter();
    const orders = [
        { id: 1, orderCode: "ORD-10", accountName: "Zulu" },
        { id: 2, orderCode: "ORD-2", accountName: "Alpha" }
    ];
    assert.deepEqual(Array.from(sort(orders, true, "accountName", "asc"), (order) => order.id), [2, 1]);
    assert.equal(sort(orders, false, "accountName", "asc"), orders);
});

test("shipped headers announce sort state and clicks rerender only the shipped view", () => {
    assert.match(source, /function renderShippedOrderSortHeader[\s\S]*?aria-sort=/);
    assert.match(source, /data-sort-shipped-orders=/);
    const handler = functionSource("onPortalOrdersListClick");
    assert.match(handler, /shippedSortButton && isShippedOrdersSection\(\)/);
    assert.match(handler, /renderPortalOrdersList\(\)/);
    assert.match(handler, /Shipped orders sorted/);
});
