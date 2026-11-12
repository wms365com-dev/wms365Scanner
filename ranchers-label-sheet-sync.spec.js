const assert = require("node:assert/strict");
const test = require("node:test");
const { HEADERS } = require("./scripts/prepare-ranchers-clickship-rows");
const { planRows, syncOnce, configuredGoogleAuth, SheetsClient, hasDuplicateOrderCodes } = require("./ranchers-label-sheet-sync");

function snapshot(account = "RANCHER'S CHIPS") {
    return {
        account, store: "f1acxk-dc.myshopify.com", warehouse: "GW3PL-MISS", integrationId: 4,
        orders: [{
            id: 900001, order_code: "ORD-900001", status: "RELEASED", po_number: "#TEST900001",
            external_order_id: "900001", ship_to_name: "Synthetic Recipient",
            ship_to_address1: "123 Fictional Rd", ship_to_city: "Toronto", ship_to_state: "ON",
            ship_to_postal_code: "M5V 2T6", ship_to_country: "CA", ship_to_phone: "4165550100",
            recipient_email: "synthetic@example.invalid", allocated_qty: 6, created_at: "2026-09-28T10:00:00Z"
        }],
        lines: [{ order_id: 900001, sku: "RTC-4OZ-EA", description: "Synthetic chips", upc: "199284767607",
            requested_quantity: 6, tracking_level: "UNIT", unit_uom: "EA" }]
    };
}

function fakeDatabase(acquired = true) {
    return { calls: [], async query(sql) {
        this.calls.push(sql);
        return { rows: [{ acquired }] };
    } };
}

function fakeSheets() {
    return {
        rows: [],
        async readState() {
            return { header: HEADERS, wmsColumn: [["WMS Order"], ...this.rows.map((row) => [row[1]])],
                sourceColumn: [["WMS Order"]] };
        },
        async appendRows(rows) {
            const first = this.rows.length + 2;
            this.rows.push(...rows);
            return { updates: { updatedRange: `WMS!A${first}:AF${first + rows.length - 1}` } };
        },
        async readAppendedOrderCodes(updatedRange) {
            const match = updatedRange.match(/!A(\d+):AF(\d+)$/);
            return this.rows.slice(Number(match[1]) - 2, Number(match[2]) - 1).map((row) => row[1]);
        }
    };
}

test("plans only exact Rancher's orders absent from both tabs", () => {
    const source = snapshot();
    assert.equal(planRows(source, [["WMS Order"]], [["WMS Order"]]).append.length, 1);
    assert.equal(planRows(source, [["WMS Order"], ["ORD-900001"]], [["WMS Order"]]).append.length, 0);
    assert.equal(planRows(source, [["WMS Order"]], [["WMS Order"], ["ORD-900001"]]).append.length, 0);
    assert.throws(() => planRows(snapshot("OTHER COMPANY"), [["WMS Order"]], [["WMS Order"]]), /identity mismatch/);
    const shipped = snapshot();
    shipped.orders[0].status = "SHIPPED";
    assert.equal(planRows(shipped, [["WMS Order"]], [["WMS Order"]]).append.length, 0);
});

test("sync appends once and a repeated run is a no-op", async () => {
    const database = fakeDatabase();
    const sheets = fakeSheets();
    const args = { database, sheets, loadSnapshot: async () => snapshot() };
    const first = await syncOnce(args);
    assert.deepEqual(first.appended, ["ORD-900001"]);
    assert.equal(first.state, "UPDATED");
    assert.equal(sheets.rows[0][0], "READY");
    assert.equal(sheets.rows[0][1], "ORD-900001");
    const second = await syncOnce(args);
    assert.equal(second.state, "UNCHANGED");
    assert.equal(sheets.rows.length, 1);
    assert.equal(database.calls.filter((sql) => sql.includes("pg_advisory_unlock")).length, 2);
});

test("busy worker and failed verification never claim success", async () => {
    const busy = await syncOnce({ database: fakeDatabase(false), sheets: fakeSheets(), loadSnapshot: async () => snapshot() });
    assert.equal(busy.state, "BUSY");
    const sheets = fakeSheets();
    sheets.readAppendedOrderCodes = async () => ["ORD-900002"];
    const database = fakeDatabase();
    await assert.rejects(syncOnce({ database, sheets, loadSnapshot: async () => snapshot() }), /did not match/);
    assert.equal(database.calls.filter((sql) => sql.includes("pg_advisory_unlock")).length, 1);
});

test("missing credentials fail closed", () => {
    assert.throws(() => configuredGoogleAuth({}), /Set RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON/);
    assert.throws(() => configuredGoogleAuth({ RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON: "not-json" }), /invalid JSON/);
});

test("Sheets client validates tab headers and existing duplicate IDs", async () => {
    let duplicate = false;
    const auth = { async getClient() { return { async request({ url }) {
        if (url.includes("?fields=")) return { data: { sheets: [
            { properties: { title: "WMS" } }, { properties: { title: "Sheet1" } }
        ] } };
        return { data: { valueRanges: [
            { values: [HEADERS] },
            { values: duplicate ? [["WMS Order"], ["ORD-900001"], ["ORD-900001"]] : [["WMS Order"]] },
            { values: [["WMS Order"]] }
        ] } };
    } }; } };
    const sheets = new SheetsClient(auth);
    assert.deepEqual((await sheets.readState()).header, HEADERS);
    duplicate = true;
    await assert.rejects(sheets.readState(), /duplicate order numbers/);
    assert.equal(hasDuplicateOrderCodes([["WMS Order"], ["ORD-900001"], ["ORD-900001"]]), true);
});
