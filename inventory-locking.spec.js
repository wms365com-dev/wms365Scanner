const test = require("node:test");
const assert = require("node:assert/strict");

const {
    APP_USER_ROLES,
    consumePortalOrderInventory,
    postInventoryCountAdjustment,
    moveInventoryToInvestigationHold,
    safeDeductInventoryLineQuantity,
    setInventoryQuantity,
    safeTransferInventoryQuantity,
    findInventoryLine,
    upsertInventoryLine,
    getInventoryTransactionHistory,
    getWarehouseReceivingStageLocationCode,
    isLocationScopedToFulfillmentWarehouse
} = require("./server.js");

const originalWarn = console.warn;

test("warehouse location rule scopes receiving stage and bins by warehouse code", () => {
    const bcWarehouse = { fulfillmentLocationCode: "OLYMPIA-BURNABY" };
    assert.equal(getWarehouseReceivingStageLocationCode(bcWarehouse), "OLYMPIA-BURNABY-REC");
    assert.equal(isLocationScopedToFulfillmentWarehouse("OLYMPIA-BURNABY-REC", bcWarehouse), true);
    assert.equal(isLocationScopedToFulfillmentWarehouse("OLYMPIA-BURNABY-RECEIVING-STAGE", bcWarehouse), true);
    assert.equal(isLocationScopedToFulfillmentWarehouse("OLYMPIA-BURNABY-A01", bcWarehouse), true);
    assert.equal(isLocationScopedToFulfillmentWarehouse("RECEIVING-STAGE", bcWarehouse), false);
    assert.equal(isLocationScopedToFulfillmentWarehouse("REC", bcWarehouse), false);
    assert.equal(isLocationScopedToFulfillmentWarehouse("GW3PL-MISS-RECEIVING-STAGE", bcWarehouse), false);
});

test("multi-warehouse inventory writes require a warehouse-prefixed location", async () => {
    const store = new SharedInventoryStore({
        warehouses: [
            { id: 1, account_name: "MULTI WAREHOUSE CO", code: "GW3PL-MISS", is_primary: true },
            { id: 2, account_name: "MULTI WAREHOUSE CO", code: "OLYMPIA-BURNABY" }
        ]
    });
    const client = store.client();

    await assert.rejects(
        () => upsertInventoryLine(client, {
            accountName: "MULTI WAREHOUSE CO",
            location: "A01",
            sku: "SKU-1",
            quantity: 5
        }),
        /must start with one of this company's warehouse codes/
    );

    await upsertInventoryLine(client, {
        accountName: "MULTI WAREHOUSE CO",
        location: "GW3PL-MISS-A01",
        sku: "SKU-1",
        quantity: 5
    });

    assert.equal([...store.lines.values()].find((line) => line.location === "GW3PL-MISS-A01")?.quantity, 5);
});

test("multi-warehouse legacy generic locations cannot have quantity increased", async () => {
    const warehouseAssignments = [
        { id: 1, account_name: "MULTI WAREHOUSE CO", code: "GW3PL-MISS", is_primary: true },
        { id: 2, account_name: "MULTI WAREHOUSE CO", code: "OLYMPIA-BURNABY" }
    ];
    const store = new SharedInventoryStore({
        warehouses: warehouseAssignments,
        lines: [{ id: 1, account_name: "MULTI WAREHOUSE CO", location: "BULK", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "CASE", quantity: 10 }]
    });

    await assert.rejects(
        () => setInventoryQuantity(store.client(), 1, 12, { actionLabel: "post inventory count" }),
        /must start with one of this company's warehouse codes/
    );

    const reduceStore = new SharedInventoryStore({
        warehouses: [
            ...warehouseAssignments
        ],
        lines: [{ id: 1, account_name: "MULTI WAREHOUSE CO", location: "BULK", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "CASE", quantity: 10 }]
    });

    await setInventoryQuantity(reduceStore.client(), 1, 8, { actionLabel: "reduce legacy generic stock" });

    assert.equal(reduceStore.lines.get("1").quantity, 8);
});

test("multi-warehouse investigation hold uses the source warehouse hold location", async () => {
    const store = new SharedInventoryStore({
        warehouses: [
            { id: 1, account_name: "MULTI WAREHOUSE CO", code: "GW3PL-MISS", is_primary: true },
            { id: 2, account_name: "MULTI WAREHOUSE CO", code: "OLYMPIA-BURNABY" }
        ],
        lines: [{ id: 1, account_name: "MULTI WAREHOUSE CO", location: "GW3PL-MISS-A01", sku: "SKU-1", upc: "", lot_number: "", expiration_date: "", tracking_level: "CASE", quantity: 4 }]
    });
    const appUser = { id: 42, role: APP_USER_ROLES.SUPER_ADMIN, email: "admin@example.com" };

    const result = await moveInventoryToInvestigationHold(store.client(), {
        accountName: "MULTI WAREHOUSE CO",
        fromLocation: "GW3PL-MISS-A01",
        skuOrUpc: "SKU-1",
        quantity: 4,
        idempotencyKey: "multi-hold-once"
    }, appUser);

    assert.equal(result.holdLocation, "GW3PL-MISS-INV");
    assert.equal(store.lines.has("1"), false);
    const heldLine = [...store.lines.values()].find((line) => line.location === "GW3PL-MISS-INV" && line.sku === "SKU-1");
    assert.equal(heldLine.quantity, 4);
    assert.equal(store.locations.get("GW3PL-MISS-INV").location_type, "QA_HOLD");
    assert.equal(store.locations.get("GW3PL-MISS-INV").is_pickable, false);
});

function cloneRow(row) {
    return row ? { ...row } : row;
}

class SharedInventoryStore {
    constructor({ lines = [], allocations = [], counts = [], locations = [], warehouses = [] } = {}) {
        this.lines = new Map(lines.map((line) => [String(line.id), { ...line }]));
        this.allocations = allocations.map((allocation) => ({ ...allocation }));
        this.counts = new Map(counts.map((count) => [String(count.id), { ...count }]));
        this.locations = new Map(locations.map((location) => [location.code, { ...location }]));
        this.warehouses = warehouses.map((warehouse, index) => ({
            id: warehouse.id || index + 1,
            account_name: warehouse.account_name || warehouse.accountName || "",
            code: warehouse.code,
            name: warehouse.name || warehouse.code,
            partner_name: warehouse.partner_name || "",
            allow_inbound: warehouse.allow_inbound !== false,
            allow_outbound: warehouse.allow_outbound !== false,
            is_primary: warehouse.is_primary === true,
            is_active: warehouse.is_active !== false
        }));
        this.confirmations = new Map();
        this.movements = new Map();
        this.movementAttachments = [];
        this.transactions = [];
        this.nextLineId = lines.reduce((max, line) => Math.max(max, Number(line.id) || 0), 0) + 1;
        this.nextTransactionId = 1;
        this.nextConfirmationId = 1;
        this.nextMovementId = 1;
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
            locations: new Map([...this.locations.entries()].map(([code, row]) => [code, { ...row }])),
            warehouses: this.warehouses.map((row) => ({ ...row })),
            confirmations: new Map([...this.confirmations.entries()].map(([key, row]) => [key, { ...row }])),
            movements: new Map([...this.movements.entries()].map(([key, row]) => [key, { ...row }])),
            movementAttachments: this.movementAttachments.map((row) => ({ ...row })),
            transactions: this.transactions.map((row) => ({ ...row }))
        };
    }

    restore(snapshot) {
        this.lines = new Map([...snapshot.lines.entries()].map(([id, row]) => [id, { ...row }]));
        this.counts = new Map([...snapshot.counts.entries()].map(([id, row]) => [id, { ...row }]));
        this.locations = new Map([...snapshot.locations.entries()].map(([code, row]) => [code, { ...row }]));
        this.warehouses = snapshot.warehouses.map((row) => ({ ...row }));
        this.confirmations = new Map([...snapshot.confirmations.entries()].map(([key, row]) => [key, { ...row }]));
        this.movements = new Map([...snapshot.movements.entries()].map(([key, row]) => [key, { ...row }]));
        this.movementAttachments = snapshot.movementAttachments.map((row) => ({ ...row }));
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

        if (normalizedSql.includes("from company_fulfillment_locations cfl")) {
            const accountName = params[0];
            const rows = this.store.warehouses.filter((row) => !row.account_name || row.account_name === accountName);
            return { rowCount: rows.length, rows: rows.map(cloneRow) };
        }

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

        if (normalizedSql.startsWith("select distinct account_name from inventory_lines where location = $1 and account_name <> $2")) {
            const [location, accountName] = params;
            const rows = [...new Set([...this.store.lines.values()]
                .filter((row) => row.location === location && row.account_name !== accountName)
                .map((row) => row.account_name))]
                .sort()
                .slice(0, 5)
                .map((name) => ({ account_name: name }));
            return { rowCount: rows.length, rows };
        }

        if (normalizedSql.startsWith("select fl.id, fl.code, fl.name, fl.partner_name")) {
            const accountName = params[0];
            const rows = this.store.warehouses
                .filter((warehouse) => warehouse.account_name === accountName && warehouse.is_active !== false && warehouse.code)
                .sort((left, right) => {
                    if (left.is_primary !== right.is_primary) return left.is_primary ? -1 : 1;
                    return String(left.code).localeCompare(String(right.code));
                })
                .map((warehouse) => ({
                    id: warehouse.id,
                    code: warehouse.code,
                    name: warehouse.name,
                    partner_name: warehouse.partner_name,
                    allow_inbound: warehouse.allow_inbound,
                    allow_outbound: warehouse.allow_outbound,
                    is_primary: warehouse.is_primary
                }));
            return { rowCount: rows.length, rows: rows.map(cloneRow) };
        }

        if (normalizedSql.startsWith("select * from fulfillment_locations where id = $1")) {
            const row = this.store.warehouses.find((warehouse) => String(warehouse.id) === String(params[0]) && warehouse.is_active !== false);
            return { rowCount: row ? 1 : 0, rows: row ? [cloneRow(row)] : [] };
        }

        if (normalizedSql.startsWith("select * from fulfillment_locations where code = $1")) {
            const row = this.store.warehouses.find((warehouse) => warehouse.code === params[0] && warehouse.is_active !== false);
            return { rowCount: row ? 1 : 0, rows: row ? [cloneRow(row)] : [] };
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

        if (normalizedSql.startsWith("insert into bin_locations")) {
            const [code, note = ""] = params;
            const existing = this.store.locations.get(code) || { code, note: "", location_type: "STORAGE", is_pickable: true };
            if (note) existing.note = note;
            this.store.locations.set(code, existing);
            return { rowCount: 1, rows: [cloneRow(existing)] };
        }

        if (normalizedSql.startsWith("update bin_locations set location_type = 'qa_hold'")) {
            const [code] = params;
            const existing = this.store.locations.get(code) || { code, note: "", location_type: "STORAGE", is_pickable: true };
            existing.location_type = "QA_HOLD";
            existing.is_pickable = false;
            if (!existing.note) existing.note = "Investigation hold - not pickable for released orders.";
            this.store.locations.set(code, existing);
            return { rowCount: 1, rows: [cloneRow(existing)] };
        }

        if (normalizedSql.startsWith("insert into item_catalog")) {
            return { rowCount: 1, rows: [] };
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
                idempotencyKey,
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
                idempotency_key: idempotencyKey || "",
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

        if (normalizedSql.startsWith("select coalesce(sum") || normalizedSql.startsWith("with sales as (")) {
            const lineId = String(params[0]);
            const activeStatuses = Array.isArray(params[1]) ? params[1] : ["RELEASED", "PICKED", "STAGED"];
            const matchingAllocations = this.store.allocations.filter((allocation) => {
                const status = allocation.status || "RELEASED";
                return String(allocation.inventory_line_id) === lineId && activeStatuses.includes(status);
            });
            const sumByStatus = (status) => matchingAllocations
                .filter((allocation) => (allocation.status || "RELEASED") === status)
                .reduce((sum, allocation) => sum + Number(allocation.allocated_quantity || 0), 0);
            const activeQuantity = matchingAllocations.reduce((sum, allocation) => sum + Number(allocation.allocated_quantity || 0), 0);
            return {
                rowCount: 1,
                rows: [{
                    released_quantity: sumByStatus("RELEASED"),
                    picked_quantity: sumByStatus("PICKED"),
                    staged_quantity: sumByStatus("STAGED"),
                    kitting_quantity: 0,
                    active_quantity: activeQuantity
                }]
            };
        }

        if (normalizedSql.startsWith("select * from portal_order_allocations where order_id = $1")) {
            const rows = this.store.allocations.filter((allocation) => String(allocation.order_id) === String(params[0]));
            return { rowCount: rows.length, rows: rows.map(cloneRow) };
        }

        if (normalizedSql.startsWith("select * from mobile_execution_confirmations where idempotency_key = $1")) {
            const row = this.store.confirmations.get(String(params[0]));
            return { rowCount: row ? 1 : 0, rows: row ? [cloneRow(row)] : [] };
        }

        if (normalizedSql.startsWith("insert into mobile_execution_confirmations")) {
            const [
                sourceId,
                workerId,
                deviceId,
                accountName,
                fromLocation,
                holdLocation,
                sku,
                lot,
                expiry,
                quantity,
                idempotencyKey,
                source
            ] = params;
            const row = {
                id: this.store.nextConfirmationId++,
                confirmation_type: "INVESTIGATION_HOLD",
                source_type: "INVENTORY_LINE",
                source_id: sourceId,
                worker_id: workerId,
                device_id: deviceId || "",
                account_name: accountName,
                location: fromLocation,
                from_location: fromLocation,
                to_location: holdLocation,
                sku,
                lot: lot || "",
                expiry: expiry || "",
                quantity: Number(quantity),
                sync_status: "SYNCED",
                idempotency_key: idempotencyKey,
                source: source || "mobile_web",
                timestamp: new Date().toISOString()
            };
            this.store.confirmations.set(String(idempotencyKey), row);
            return { rowCount: 1, rows: [cloneRow(row)] };
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

        if (normalizedSql.startsWith("insert into inventory_movements")) {
            const [movementKey, accountName, fulfillmentLocationId, movementType, fromLocation, toLocation, sku, lotNumber, expirationDate, quantity, trackingLevel, reason, performedBy] = params;
            const row = {
                id: this.store.nextMovementId++,
                movement_key: movementKey,
                account_name: accountName,
                fulfillment_location_id: fulfillmentLocationId,
                movement_type: movementType,
                from_location: fromLocation,
                to_location: toLocation,
                sku,
                lot_number: lotNumber,
                expiration_date: expirationDate,
                quantity,
                tracking_level: trackingLevel,
                reason,
                performed_by: performedBy,
                created_at: new Date().toISOString()
            };
            this.store.movements.set(String(movementKey), row);
            return { rowCount: 1, rows: [cloneRow(row)] };
        }

        if (normalizedSql.startsWith("insert into inventory_movement_attachments")) {
            this.store.movementAttachments.push({ movement_id: params[0], file_name: params[1] });
            return { rowCount: 1, rows: [] };
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

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(results.map((result) => result.status === "rejected" ? result.reason.message : "ok")));
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

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(results.map((result) => result.status === "rejected" ? result.reason.message : "ok")));
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(total, 10);
    assert.equal(store.transactions.length, 2);
    assert.deepEqual(store.transactions.map((row) => row.quantity_delta).sort((a, b) => a - b), [-6, 6]);
});

test("mobile investigation hold moves available stock into a non-pickable hold location once", async () => {
    const store = new SharedInventoryStore({
        warehouses: [{ id: 1, account_name: "PURE FOODS BY ESTEE", code: "GW3PL-MISS", is_primary: true }],
        lines: [{ id: 1, account_name: "PURE FOODS BY ESTEE", location: "PUREFOODS-BULK", sku: "140", upc: "", lot_number: "", expiration_date: "", tracking_level: "CASE", quantity: 124 }]
    });
    const appUser = { id: 42, role: APP_USER_ROLES.SUPER_ADMIN, email: "admin@example.com" };

    const result = await moveInventoryToInvestigationHold(store.client(), {
        accountName: "PURE FOODS BY ESTEE",
        fromLocation: "PUREFOODS-BULK",
        skuOrUpc: "140",
        quantity: 124,
        note: "Count discrepancy",
        idempotencyKey: "hold-140-once"
    }, appUser);

    assert.equal(result.holdLocation, "GW3PL-MISS-INV");
    assert.equal(store.lines.has("1"), false);
    const heldLine = [...store.lines.values()].find((line) => line.location === "GW3PL-MISS-INV" && line.sku === "140");
    assert.equal(heldLine.quantity, 124);
    assert.equal(store.locations.get("GW3PL-MISS-INV").location_type, "QA_HOLD");
    assert.equal(store.locations.get("GW3PL-MISS-INV").is_pickable, false);
    assert.equal(store.confirmations.size, 1);
    assert.deepEqual(store.transactions.map((row) => row.quantity_delta).sort((a, b) => a - b), [-124, 124]);

    const duplicate = await moveInventoryToInvestigationHold(store.client(), {
        accountName: "PURE FOODS BY ESTEE",
        fromLocation: "PUREFOODS-BULK",
        skuOrUpc: "140",
        quantity: 124,
        idempotencyKey: "hold-140-once"
    }, appUser);

    assert.equal(duplicate.duplicate, true);
    assert.equal(store.confirmations.size, 1);
    assert.equal([...store.lines.values()].reduce((sum, line) => sum + Number(line.quantity), 0), 124);
});

test("mobile investigation hold cannot move stock committed to active orders", async () => {
    const store = new SharedInventoryStore({
        warehouses: [{ id: 1, account_name: "PURE FOODS BY ESTEE", code: "GW3PL-MISS", is_primary: true }],
        lines: [{ id: 1, account_name: "PURE FOODS BY ESTEE", location: "PUREFOODS-BULK", sku: "133", upc: "", lot_number: "", expiration_date: "", tracking_level: "CASE", quantity: 109 }],
        allocations: [{ id: 10, inventory_line_id: 1, allocated_quantity: 5, status: "RELEASED" }]
    });
    const appUser = { id: 42, role: APP_USER_ROLES.SUPER_ADMIN, email: "admin@example.com" };

    await assert.rejects(
        () => moveInventoryToInvestigationHold(store.client(), {
            accountName: "PURE FOODS BY ESTEE",
            fromLocation: "PUREFOODS-BULK",
            skuOrUpc: "133",
            quantity: 109,
            idempotencyKey: "hold-133-too-much"
        }, appUser),
        /only 104 cases are available/
    );

    assert.equal(store.lines.get("1").quantity, 109);
    assert.equal([...store.lines.values()].some((line) => line.location === "GW3PL-MISS-INV" && line.sku === "133"), false);
    assert.equal(store.confirmations.size, 0);
    assert.equal(store.transactions.length, 0);
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
    const order = { id: 99, orderCode: "ORD-000099", accountName: "WMS365 TEST COMPANY", lines: [{ id: 9, sku: "SKU-1", quantity: 6, trackingLevel: "UNIT" }] };

    const transfer = async () => {
        const client = store.client();
        const line = await findInventoryLine(client, "WMS365 TEST COMPANY", "A1", "SKU-1", { lock: true });
        try {
            await safeTransferInventoryQuantity(client, line, {
                accountName: "WMS365 TEST COMPANY",
                location: "B1",
                sku: "SKU-1",
                trackingLevel: "UNIT"
            }, 4, { actionLabel: "transfer while shipping" });
        } catch (error) {
            client.releaseLine(line.id); // Simulate transaction rollback releasing FOR UPDATE locks.
            throw error;
        }
    };

    const results = await Promise.allSettled([
        consumePortalOrderInventory(store.client(), order),
        transfer()
    ]);
    const total = [...store.lines.values()].reduce((sum, row) => sum + Number(row.quantity), 0);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(results.map((result) => result.status === "rejected" ? result.reason.message : "ok")));
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
