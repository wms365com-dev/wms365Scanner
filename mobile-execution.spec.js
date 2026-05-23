const test = require("node:test");
const assert = require("node:assert/strict");

const {
    APP_USER_ROLES,
    savePickConfirmation,
    saveMobileExecutionConfirmation,
    filterMobilePickOrdersForAppUser
} = require("./server.js");

function clone(row) {
    return row ? { ...row } : row;
}

class MobileExecutionClient {
    constructor() {
        this.orders = new Map([["31", { id: 31, account_name: "HEALTEA", status: "RELEASED", order_code: "ORD-000031" }]]);
        this.lines = new Map([["101", { id: 101, order_id: 31, sku: "30627843973325", requested_quantity: 36, item_lot_tracked: false, item_expiration_tracked: false }]]);
        this.allocations = [
            { id: 1, order_id: 31, order_line_id: 101, sku: "30627843973325", location: "A-01", lot_number: "", expiration_date: "", allocated_quantity: 36 }
        ];
        this.pickConfirmations = [];
        this.mobileConfirmations = [];
        this.activities = [];
        this.nextPickId = 1;
        this.nextMobileId = 1;
    }

    async query(sql, params = []) {
        const normalizedSql = String(sql).replace(/\s+/g, " ").trim().toLowerCase();

        if (normalizedSql.startsWith("select * from pick_confirmations where idempotency_key = $1")) {
            const row = this.pickConfirmations.find((entry) => entry.idempotency_key === params[0]);
            return { rowCount: row ? 1 : 0, rows: row ? [clone(row)] : [] };
        }

        if (normalizedSql.startsWith("select * from mobile_execution_confirmations where idempotency_key = $1")) {
            const row = this.mobileConfirmations.find((entry) => entry.idempotency_key === params[0]);
            return { rowCount: row ? 1 : 0, rows: row ? [clone(row)] : [] };
        }

        if (normalizedSql.startsWith("select * from portal_orders where id = $1")) {
            const row = this.orders.get(String(params[0]));
            return { rowCount: row ? 1 : 0, rows: row ? [clone(row)] : [] };
        }

        if (normalizedSql.includes("from portal_order_lines l")) {
            const [, orderId, lineId, sku] = params;
            const rows = [...this.lines.values()].filter((line) => Number(line.order_id) === Number(orderId)
                && ((lineId && Number(line.id) === Number(lineId)) || (!lineId && line.sku === sku)));
            return { rowCount: rows.length, rows: rows.map(clone) };
        }

        if (normalizedSql.includes("from portal_order_allocations")) {
            const [orderId, lineId] = params;
            const rows = this.allocations.filter((row) => Number(row.order_id) === Number(orderId) && Number(row.order_line_id) === Number(lineId));
            return { rowCount: rows.length, rows: rows.map(clone) };
        }

        if (normalizedSql.includes("from pick_confirmations") && normalizedSql.includes("coalesce(sum(quantity)")) {
            const [orderId, lineId, location, sku, lot, expiry] = params;
            const rows = this.pickConfirmations.filter((row) => Number(row.order_id) === Number(orderId)
                && Number(row.line_id) === Number(lineId)
                && row.sync_status !== "FAILED"
                && (params.length < 6 || (row.location === location && row.sku === sku && row.lot === lot && row.expiry === expiry)));
            return { rowCount: 1, rows: [{ quantity: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0) }] };
        }

        if (normalizedSql.startsWith("insert into pick_confirmations")) {
            const [orderId, lineId, workerId, deviceId, location, sku, lot, expiry, quantity, idempotencyKey, source] = params;
            const row = {
                id: this.nextPickId++,
                order_id: orderId,
                line_id: lineId,
                worker_id: workerId,
                device_id: deviceId,
                location,
                sku,
                lot,
                expiry,
                quantity,
                timestamp: new Date(),
                sync_status: "SYNCED",
                idempotency_key: idempotencyKey,
                source
            };
            this.pickConfirmations.push(row);
            return { rowCount: 1, rows: [clone(row)] };
        }

        if (normalizedSql.startsWith("insert into mobile_execution_confirmations")) {
            const [confirmationType, sourceType, sourceId, workerId, deviceId, accountName, location, fromLocation, toLocation, sku, lot, expiry, quantity, idempotencyKey, source, payload] = params;
            const row = {
                id: this.nextMobileId++,
                confirmation_type: confirmationType,
                source_type: sourceType,
                source_id: sourceId,
                worker_id: workerId,
                device_id: deviceId,
                account_name: accountName,
                location,
                from_location: fromLocation,
                to_location: toLocation,
                sku,
                lot,
                expiry,
                quantity,
                sync_status: "SYNCED",
                idempotency_key: idempotencyKey,
                source,
                payload,
                timestamp: new Date()
            };
            this.mobileConfirmations.push(row);
            return { rowCount: 1, rows: [clone(row)] };
        }

        if (normalizedSql.startsWith("insert into activity_log")) {
            const row = { id: this.activities.length + 1, type: params[0], title: params[1], details: params[2], created_at: new Date() };
            this.activities.push(row);
            return { rowCount: 1, rows: [clone(row)] };
        }

        throw new Error(`Unhandled SQL in mobile execution test: ${normalizedSql}`);
    }
}

function superAdmin() {
    return { id: 1, email: "admin@example.com", role: APP_USER_ROLES.SUPER_ADMIN };
}

test("valid pick scan creates server confirmation", async () => {
    const client = new MobileExecutionClient();
    const result = await savePickConfirmation(client, {
        orderId: 31,
        lineId: 101,
        location: "A-01",
        sku: "30627843973325",
        quantity: 5,
        idempotencyKey: "pick-1",
        deviceId: "android-test"
    }, superAdmin());

    assert.equal(result.duplicate, false);
    assert.equal(client.pickConfirmations.length, 1);
    assert.equal(result.confirmation.quantity, 5);
});

test("duplicate pick scan idempotency key does not insert twice", async () => {
    const client = new MobileExecutionClient();
    const body = { orderId: 31, lineId: 101, location: "A-01", sku: "30627843973325", quantity: 5, idempotencyKey: "pick-dup" };
    await savePickConfirmation(client, body, superAdmin());
    const duplicate = await savePickConfirmation(client, body, superAdmin());

    assert.equal(duplicate.duplicate, true);
    assert.equal(client.pickConfirmations.length, 1);
});

test("wrong SKU and wrong location are rejected by backend validation", async () => {
    const client = new MobileExecutionClient();
    await assert.rejects(
        () => savePickConfirmation(client, { orderId: 31, lineId: 101, location: "A-01", sku: "WRONG", quantity: 1, idempotencyKey: "bad-sku" }, superAdmin()),
        /Scanned SKU does not match/
    );
    await assert.rejects(
        () => savePickConfirmation(client, { orderId: 31, lineId: 101, location: "B-99", sku: "30627843973325", quantity: 1, idempotencyKey: "bad-location" }, superAdmin()),
        /not allocated/
    );
});

test("pick scan cannot exceed allocated quantity", async () => {
    const client = new MobileExecutionClient();
    await savePickConfirmation(client, { orderId: 31, lineId: 101, location: "A-01", sku: "30627843973325", quantity: 35, idempotencyKey: "pick-35" }, superAdmin());

    await assert.rejects(
        () => savePickConfirmation(client, { orderId: 31, lineId: 101, location: "A-01", sku: "30627843973325", quantity: 2, idempotencyKey: "pick-over" }, superAdmin()),
        /exceed/
    );
});

test("generic mobile confirmations are idempotent", async () => {
    const client = new MobileExecutionClient();
    const body = { accountName: "HEALTEA", location: "DOCK", sku: "SKU-1", quantity: 10, idempotencyKey: "receive-1", source: "android_app" };
    const first = await saveMobileExecutionConfirmation(client, "RECEIVING", body, superAdmin());
    const second = await saveMobileExecutionConfirmation(client, "RECEIVING", body, superAdmin());

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(client.mobileConfirmations.length, 1);
});

test("mobile pick order feed keeps workers scoped to accessible or assigned orders", () => {
    const worker = { id: "7", role: "warehouse_worker" };
    const orders = [
        { id: "1", accountName: "HEALTEA", status: "RELEASED" },
        { id: "2", accountName: "OTHER CUSTOMER", status: "RELEASED" },
        { id: "3", accountName: "OTHER CUSTOMER", status: "DRAFT" },
        { id: "4", accountName: "ASSIGNED CUSTOMER", status: "PICKED" }
    ];

    const visible = filterMobilePickOrdersForAppUser(orders, worker, {
        accessibleCompanies: ["HEALTEA"],
        assignedOrderIds: ["4"]
    });

    assert.deepEqual(visible.map((order) => order.id), ["1", "4"]);
});
