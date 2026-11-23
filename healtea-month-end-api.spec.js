const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.HEALTEA_API_TOKEN = process.env.HEALTEA_API_TOKEN || "test-healtea-token";

const { getHealteaMonthEndPeriod, buildHealteaMonthEndActivity } = require("./server");

test("Healtea month-end periods use strict calendar month boundaries", () => {
    assert.deepEqual(getHealteaMonthEndPeriod("2026-12"), {
        month: "2026-12",
        startDate: "2026-12-01",
        endDateExclusive: "2027-01-01",
        timeZone: "America/Toronto"
    });
    assert.throws(() => getHealteaMonthEndPeriod("2026-13"), /YYYY-MM/);
    assert.throws(() => getHealteaMonthEndPeriod("September 2026"), /YYYY-MM/);
});

test("Healtea month-end report remains tenant scoped and reconciles summaries", async () => {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes("from owner_accounts")) return { rowCount: 1, rows: [{ id: 8, name: "HEALTEA", is_active: true }] };
            if (sql.includes("from portal_orders")) return { rows: [
                { order_code: "ORD-1", ship_date: "2026-09-02", line_number: 1, sku: "A", requested_quantity: 2, shipped_quantity: 2 },
                { order_code: "ORD-1", ship_date: "2026-09-02", line_number: 2, sku: "B", requested_quantity: 3, shipped_quantity: 3 }
            ] };
            if (sql.includes("from portal_inbounds")) return { rows: [
                { inbound_code: "INB-1", received_date: "2026-09-03", line_number: 1, sku: "A", expected_quantity: 6, received_quantity: 6 }
            ] };
            if (sql.includes("from inventory_transactions")) return { rows: [
                { transaction_type: "RECEIVE", quantity_delta: 6, quantity_before: 0, quantity_after: 6 },
                { transaction_type: "SHIP", quantity_delta: -5, quantity_before: 6, quantity_after: 1 }
            ] };
            if (sql.includes("from billing_events")) return { rows: [
                { currency_code: "CAD", amount: "12.345", status: "OPEN" },
                { currency_code: "CAD", amount: "2.005", status: "OPEN" }
            ] };
            throw new Error(`Unexpected query: ${sql}`);
        }
    };

    const report = await buildHealteaMonthEndActivity(client, "2026-09");
    assert.equal(report.accountName, "HEALTEA");
    assert.equal(report.summary.shippedOrders, 1);
    assert.equal(report.summary.shippedLineQuantity, 5);
    assert.equal(report.summary.receivedInbounds, 1);
    assert.equal(report.summary.receivedLineQuantity, 6);
    assert.equal(report.summary.netInventoryQuantityChange, 1);
    assert.deepEqual(report.summary.billingAmountByCurrency, { CAD: 14.35 });
    assert.equal(report.outbound[0].orderCode, "ORD-1");
    assert.ok(!Object.hasOwn(report.outbound[0], "shipToName"));
    assert.ok(calls.every((call) => call.params?.[0] === "HEALTEA"));
    assert.ok(calls.slice(1).every((call) => call.params[1] === "2026-09-01" && call.params[2] === "2026-10-01"));
});

test("Healtea month-end report fails closed when exact company is inactive", async () => {
    const client = { query: async () => ({ rowCount: 1, rows: [{ id: 8, name: "HEALTEA", is_active: false }] }) };
    await assert.rejects(() => buildHealteaMonthEndActivity(client, "2026-09"), /scope is unavailable/);
});
