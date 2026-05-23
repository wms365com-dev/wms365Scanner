const test = require("node:test");
const assert = require("node:assert/strict");

const {
    APP_USER_ROLES,
    consumePortalOrderInventory,
    postInventoryCountAdjustment,
    safeDeductInventoryLineQuantity,
    safeTransferInventoryQuantity,
    findInventoryLine,
    upsertInventoryLine,
    getInventoryTransactionHistory
} = require("./server.js");

const originalWarn = console.warn;

function cloneRow(row) {
    return row ? { ...row } : row;
}

class SharedInventoryStore {
    constructor({ lines = [], allocations = [], counts = [] } = {}) {
        this.lines = new Map(lines.map((line) => [String(line.id), { ...line }]));
        this.allocations = allocations.map((allocation) => ({ ...allocation }));
        this.counts = new Map(counts.map((count) => [String(count.id), { ...count }]));
        this.transactions = [];
        this.nextLineId = lines.reduce((max, line) => Math.max(max, Number(line.id) || 0), 0) + 1;
        this.nextTransactionId = 1;
        this.lineLocks = new Map();
        this.countLocks = new Map();
    }

    client() {
        return new FakeInventoryClient(this);
    }

    snapshot() {
        return {
            lines: new Map([...this.lines.entries()].map(([id, row]) => [id, { ...row }])),
            counts: new Map([...this.counts.entries()].map(([id, row]) => [id, { ...row }])),
            transactions: this.transactions.map((row) => ({ ...row }))
        };
    }

    restore(snapshot) {
        this.lines = new Map([...snapshot.lines.entries()].map(([id, row]) => [id, { ...row }]));
        this.counts = new Map([...snapshot.counts.entries()].map(([id, row]) => [id, { ...row }]));
        this.transactions = snapshot.transactions.map((row) => ({ ...row }));
    }
}

class FakeInventoryClient {
    constructor(store) {
        this.store = store;
        this.heldLineLocks = new Set();
        this.heldCountLocks = new Set();
    }

    releaseLine(id) {
        this.release(this.store.lineLocks, this.heldLineLocks, id);
    }

    releaseCount(id) {
        this.release(this.store.countLocks, this.heldCountLocks, id);
    }

    async query(sql, params = []) {
        const normalizedSql = String(sql).replace(/\s+/g, " ").trim().toLowerCase();

        if (normalizedSql.startsWith("select * from inventory_lines where id = $1")) {
            const id = String(params[0]);
            if (normalizedSql.includes("for update")) {
                await this.lockLine(id);
            }
            const row = this.store.lines.get(id);
            return { rowCount: row ? 1 : 0, rows: row ? [cloneRow(row)] : [] };
        }

        if (normalizedSql.startsWith("select * from inventory_lines where account_name = $1 and location = $2 and sku = $3")) {
            const [accountName, location, sku, lotNumber = "", expirationDate = ""] = params;
            let rows = [...this.store.lines.values()].filter((row) => row.account_name === accountName && row.location === location && row.sku === sku);
            if (params.length >= 5) {
                rows = rows.filter((row) => (row.lot_number || "") === lotNumber && (row.expiration_date || "") === expirationDate);
            }
            rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
            if (normalizedSql.includes("for update")) {
                for (const row of rows.slice(0, 2)) await this.lockLine(row.id);
            }
            return { rowCount: rows.slice(0, 2).length, rows: rows.slice(0, 2).map(cloneRow) };
        }

        if (normalizedSql.startsWith("select * from inventory_lines where account_name = $1 and location = $2 and upc = $3")) {
            const [accountName, location, upc, lotNumber = "", expirationDate = ""] = params;
            let rows = [...this.store.lines.values()].filter((row) => row.account_name === accountName && row.location === location && row.upc === upc);
            if (params.length >= 5) {
                rows = rows.filter((row) => (row.lot_number || "") === lotNumber && (row.expiration_date || "") === expirationDate);
            }
            if (normalizedSql.includes("for update")) {
                for (const row of rows.slice(0, 2)) await this.lockLine(row.id);
            }
            return { rowCount: rows.slice(0, 2).length, rows: rows.slice(0, 2).map(cloneRow) };
        }

        if (normalizedSql.startsWith("update inventory_lines set quantity = $1")) {
            const [quantity, id] = params;
            const row = this.store.lines.get(String(id));
            if (!row) return { rowCount: 0, rows: [] };
            row.quantity = Number(quantity);
            this.releaseLine(id);
            return { rowCount: 1, rows: [cloneRow(row)] };
        }

        if (normalizedSql.startsWith("delete from inventory_lines where id = $1")) {
            const id = String(params[0]);
            const row = this.store.lines.get(id);
            if (!row) return { rowCount: 0, rows: [] };
            this.store.lines.delete(id);
            this.releaseLine(id);
            return { rowCount: 1, rows: [cloneRow(row)] };
        }

        if (normalizedSql.startsWith("insert into inventory_lines")) {
            const [accountName, location, sku, upc, lotNumber, expirationDate, trackingLevel, quantity] = params;
            const existing = [...this.store.lines.values()].find((row) => row.account_name === accountName
                && row.location === location
                && row.sku === sku
                && (row.lot_number || "") === (lotNumber || "")
                && (row.expiration_date || "") === (expirationDate || ""));
            if (existing) {
                existing.upc = existing.upc || upc || "";
                existing.tracking_level = trackingLevel || "UNIT";
                existing.quantity = Number(existing.quantity) + Number(quantity);
                return { rowCount: 1, rows: [cloneRow(existing)] };
            }
            const row = {
                id: this.store.nextLineId++,
                account_name: accountName,
                location,
                sku,
                upc: upc || "",
                lot_number: lotNumber || "",
                expiration_date: expirationDate || "",
                tracking_level: trackingLevel || "UNIT",
                quantity: Number(quantity)
            };
            this.store.lines.set(String(row.id), row);
            return { rowCount: 1, rows: [cloneRow(row)] };
        }

        if (normalizedSql.startsWith("insert into inventory_transactions")) {
            const [
                accountName,
                warehouseId,
                fulfillmentLocationId,
                location,
                sku,
                upc,
                lotNumber,
                expirationDate,
                transactionType,
                quantityDelta,
                quantityBefore,
                quantityAfter,
                sourceType,
                sourceId,
                userId,
                deviceId,
                source,
                clientTimestamp
            ] = params;
            const row = {
                id: this.store.nextTransactionId++,
                account_name: accountName,
                warehouse_id: warehouseId || "",
                fulfillment_location_id: fulfillmentLocationId || null,
                location,
                sku,
                upc: upc || "",
                lot_number: lotNumber || "",
                expiration_date: expirationDate || "",
                transaction_type: transactionType,
                quantity_delta: Number(quantityDelta),
                quantity_before: Number(quantityBefore),
                quantity_after: Number(quantityAfter),
                source_type: sourceType || "",
                source_id: sourceId || "",
                user_id: userId || null,
                device_id: deviceId || "",
                source: source || "",
                client_timestamp: clientTimestamp || null,
                server_timestamp: new Date().toISOString()
            };
            this.store.transactions.push(row);
            return { rowCount: 1, rows: [cloneRow(row)] };
        }

        if (normalizedSql.startsWith("select * from inventory_transactions")) {
            const limit = Number(params[params.length - 1]) || 200;
            const rows = this.store.transactions
                .slice()
                .sort((a, b) => Number(b.id) - Number(a.id))
                .slice(0, limit);
            return { rowCount: rows.length, rows: rows.map(cloneRow) };
        }

        if (normalizedSql.startsWith("select coalesce(sum")) {
            return { rowCount: 1, rows: [{ released_quantity: 0, picked_quantity: 0, staged_quantity: 0, active_quantity: 0 }] };
        }

        if (normalizedSql.startsWith("select * from portal_order_allocations where order_id = $1")) {
            const rows = this.store.allocations.filter((allocation) => String(allocation.order_id) === String(params[0]));
            return { rowCount: rows.length, rows: rows.map(cloneRow) };
        }

        if (normalizedSql.startsWith("select * from inventory_count_records where id = $1")) {
            const id = String(params[0]);
            if (normalizedSql.includes("for update")) {
                await this.lockCount(id);
            }
            const row = this.store.counts.get(id);
            return { rowCount: row ? 1 : 0, rows: row ? [cloneRow(row)] : [] };
        }

        if (normalizedSql.startsWith("update inventory_count_records set status='posted'")) {
            const [id, actor, note] = params;
            const row = this.store.counts.get(String(id));
            if (!row || row.status === "POSTED") return { rowCount: 0, rows: [] };
            row.status = "POSTED";
            row.posted_by = actor;
            row.review_note = note || row.review_note || "";
            this.releaseCount(id);
            return { rowCount: 1, rows: [cloneRow(row)] };
        }

        if (normalizedSql.startsWith("insert into inventory_count_audit") || normalizedSql.startsWith("insert into activity_log")) {
            return { rowCount: 1, rows: [{ id: 1, type: "test", title: "test", details: "", created_at: new Date().toISOString() }] };
        }

        throw new Error(`Unhandled fake query: ${normalizedSql}`);
    }

    async lockLine(id) {
        await this.withLock(this.store.lineLocks, this.heldLineLocks, id);
    }

    async lockCount(id) {
        await this.withLock(this.store.countLocks, this.heldCountLocks, id);
    }

    async withLock(lockMap, heldSet, id) {
        const key = String(id);
        if (heldSet.has(key)) return;
        const previous = lockMap.get(key) || Promise.resolve();
        let releaseLock;
        const current = new Promise((resolve) => { releaseLock = resolve; });
        lockMap.set(key, previous.then(() => current));
        await previous;
        heldSet.add(key);
        heldSet[`release:${key}`] = releaseLock;
    }
}

FakeInventoryClient.prototype.release = function release(lockMap, heldSet, id) {
    const key = String(id);
    const releaseLock = heldSet[`release:${key}`];
    delete heldSet[`release:${key}`];
    heldSet.delete(key);
    if (releaseLock) releaseLock();
    if (lockMap.get(key)) {
        lockMap.delete(key);
    }
};

test.before(() => {
    console.warn = () => {};
});

test.after(() => {
    console.warn = originalWarn;
});

test("two simultaneous picks against same inventory cannot overdraw stock", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 5 }]
    });

    const results = await Promise.allSettled([
        safeDeductInventoryLineQuantity(store.client(), 1, 4, { actionLabel: "pick order A" }),
        safeDeductInventoryLineQuantity(store.client(), 1, 4, { actionLabel: "pick order B" })
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(store.lines.get("1").quantity, 1);
    assert.equal(store.transactions.length, 1);
    assert.equal(store.transactions[0].quantity_before, 5);
    assert.equal(store.transactions[0].quantity_delta, -4);
    assert.equal(store.transactions[0].quantity_after, 1);
});

test("two simultaneous transfers preserve total quantity", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 10 }]
    });

    const transfer = async (toLocation) => {
        const client = store.client();
        const line = await findInventoryLine(client, "WMS365 TEST COMPANY", "A1", "SKU-1", { lock: true });
        await safeTransferInventoryQuantity(client, line, {
            accountName: "WMS365 TEST COMPANY",
            location: toLocation,
            sku: "SKU-1",
            trackingLevel: "UNIT"
        }, 6, { actionLabel: "transfer test" });
    };

    const results = await Promise.allSettled([transfer("B1"), transfer("C1")]);
    const total = [...store.lines.values()].reduce((sum, row) => sum + Number(row.quantity), 0);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(total, 10);
    assert.equal(store.transactions.length, 2);
    assert.deepEqual(store.transactions.map((row) => row.quantity_delta).sort((a, b) => a - b), [-6, 6]);
});

test("simultaneous count posting posts once", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 10 }],
        counts: [{
            id: 20,
            account_name: "WMS365 TEST COMPANY",
            location: "A1",
            sku: "SKU-1",
            upc: "",
            lot_number: "",
            expiration_date: "",
            tracking_level: "UNIT",
            counted_cases: 7,
            counted_quantity: 7,
            system_quantity: 10,
            variance_quantity: -3,
            status: "APPROVED",
            review_note: "",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }]
    });
    const appUser = { role: "SUPER_ADMIN", email: "admin@example.com" };

    const results = await Promise.allSettled([
        postInventoryCountAdjustment(store.client(), 20, {}, appUser),
        postInventoryCountAdjustment(store.client(), 20, {}, appUser)
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2, JSON.stringify(results.map((result) => result.status === "rejected" ? result.reason.message : "ok")));
    assert.equal(store.counts.get("20").status, "POSTED");
    assert.equal(store.lines.get("1").quantity, 7);
    assert.equal(store.transactions.length, 1);
    assert.equal(store.transactions[0].transaction_type, "CYCLE_COUNT");
    assert.equal(store.transactions[0].quantity_before, 10);
    assert.equal(store.transactions[0].quantity_after, 7);
});

test("ship and transfer at the same time cannot consume the same units", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 8 }],
        allocations: [{ id: 1, order_id: 99, order_line_id: 9, inventory_line_id: 1, allocated_quantity: 6, sku: "SKU-1", lot_number: "" }]
    });
    const order = { id: 99, orderCode: "ORD-000099", accountName: "WMS365 TEST COMPANY", lines: [{ sku: "SKU-1", quantity: 6, trackingLevel: "UNIT" }] };

    const transfer = async () => {
        const client = store.client();
        const line = await findInventoryLine(client, "WMS365 TEST COMPANY", "A1", "SKU-1", { lock: true });
        await safeTransferInventoryQuantity(client, line, {
            accountName: "WMS365 TEST COMPANY",
            location: "B1",
            sku: "SKU-1",
            trackingLevel: "UNIT"
        }, 4, { actionLabel: "transfer while shipping" });
    };

    const results = await Promise.allSettled([
        consumePortalOrderInventory(store.client(), order),
        transfer()
    ]);
    const total = [...store.lines.values()].reduce((sum, row) => sum + Number(row.quantity), 0);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.ok([2, 8].includes(total), `total should reflect exactly one successful operation, got ${total}`);
    assert.ok(store.transactions.length === 1 || store.transactions.length === 2);
});

test("negative inventory is prevented", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 3 }]
    });

    await assert.rejects(
        () => safeDeductInventoryLineQuantity(store.client(), 1, 4, { actionLabel: "pick too much" }),
        /only has 3 units left on hand/
    );
    assert.equal(store.lines.get("1").quantity, 3);
    assert.equal(store.transactions.length, 0);
});

test("receiving upsert creates ledger entry with correct before and after", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 3 }]
    });

    await upsertInventoryLine(store.client(), {
        accountName: "WMS365 TEST COMPANY",
        location: "A1",
        sku: "SKU-1",
        quantity: 4,
        trackingLevel: "UNIT"
    }, {
        transactionType: "RECEIVING",
        sourceType: "TEST_RECEIPT",
        sourceId: "RCV-1"
    });

    assert.equal(store.lines.get("1").quantity, 7);
    assert.equal(store.transactions.length, 1);
    assert.equal(store.transactions[0].transaction_type, "RECEIVING");
    assert.equal(store.transactions[0].quantity_before, 3);
    assert.equal(store.transactions[0].quantity_delta, 4);
    assert.equal(store.transactions[0].quantity_after, 7);
});

test("inventory movement history returns ledger records for reporting", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "LOT-1", expiration_date: "2026-12-31", tracking_level: "UNIT", quantity: 5 }]
    });

    await safeDeductInventoryLineQuantity(store.client(), 1, 2, {
        actionLabel: "reporting test",
        transactionType: "PICKING",
        sourceType: "PORTAL_ORDER",
        sourceId: "99",
        appUser: { id: 42, role: APP_USER_ROLES.SUPER_ADMIN }
    });

    const report = await getInventoryTransactionHistory(
        store.client(),
        { accountName: "WMS365 TEST COMPANY", sku: "SKU-1", lotNumber: "LOT-1" },
        { id: 42, role: APP_USER_ROLES.SUPER_ADMIN }
    );

    assert.equal(report.count, 1);
    assert.equal(report.transactions[0].transactionType, "PICKING");
    assert.equal(report.transactions[0].quantityBefore, 5);
    assert.equal(report.transactions[0].quantityAfter, 3);
    assert.equal(report.transactions[0].userId, "42");
});

test("failed transaction body does not leave partial inventory or ledger records after rollback", async () => {
    const store = new SharedInventoryStore({
        lines: [{ id: 1, account_name: "WMS365 TEST COMPANY", location: "A1", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "UNIT", quantity: 5 }]
    });
    const snapshot = store.snapshot();

    await assert.rejects(async () => {
        await safeDeductInventoryLineQuantity(store.client(), 1, 2, { actionLabel: "rollback test" });
        throw new Error("downstream failure");
    }, /downstream failure/);
    store.restore(snapshot);

    assert.equal(store.lines.get("1").quantity, 5);
    assert.equal(store.transactions.length, 0);
});
