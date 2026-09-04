const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildPortalInboundInitialStorageBillingRollups,
    createPortalInboundBillingEvents,
    createPortalOrderBillingEvents,
    getWarehouseBillingActivityServiceDate,
    shouldSendWarehouseBillingActivityEmail
} = require("./server");

function createBillingClient(enabledFees = {}) {
    const events = [];
    return {
        events,
        async query(sql, params = []) {
            if (String(sql).includes("from billing_fee_catalog")) {
                const feeCode = params[1];
                if (!Object.prototype.hasOwnProperty.call(enabledFees, feeCode)) return { rowCount: 0, rows: [] };
                return {
                    rowCount: 1,
                    rows: [{
                        code: feeCode,
                        category: feeCode.includes("STORAGE") ? "Storage" : "Handling",
                        name: feeCode,
                        unit_label: "per pallet",
                        default_rate: 0,
                        is_active: true,
                        owner_rate: enabledFees[feeCode],
                        owner_enabled: true,
                        owner_unit_label: "per pallet",
                        owner_note: ""
                    }]
                };
            }
            if (String(sql).includes("insert into billing_events")) {
                const [eventKey, accountName, feeCode, feeCategory, feeName, unitLabel, quantity, rate, amount, currencyCode, serviceDate, sourceType, sourceRef, reference, note, metadata] = params;
                const row = {
                    id: events.length + 1,
                    event_key: eventKey,
                    account_name: accountName,
                    fee_code: feeCode,
                    fee_category: feeCategory,
                    fee_name: feeName,
                    unit_label: unitLabel,
                    quantity,
                    rate,
                    amount,
                    currency_code: currencyCode,
                    service_date: serviceDate,
                    status: "OPEN",
                    source_type: sourceType,
                    source_ref: sourceRef,
                    reference,
                    note,
                    metadata: JSON.parse(metadata || "{}"),
                    created_at: new Date("2026-09-01T12:00:00Z"),
                    updated_at: new Date("2026-09-01T12:00:00Z")
                };
                events.push(row);
                return { rowCount: 1, rows: [row] };
            }
            if (String(sql).includes("select * from billing_events where event_key")) {
                const row = events.find((event) => event.event_key === params[0]);
                return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
            }
            throw new Error(`Unexpected mock query: ${sql}`);
        }
    };
}

const alconaPolicy = {
    accountName: "ALCONA TRADING LTD",
    isEnabled: true,
    effectiveFrom: "2026-09-01",
    notifyOnInboundReceived: true,
    notifyOnOrderShipped: true,
    includeSourceDocuments: true,
    includeSystemDocuments: true,
    chargeInitialStorageOnReceipt: true
};

test("company billing policy starts on its effective transaction date", () => {
    assert.equal(shouldSendWarehouseBillingActivityEmail(alconaPolicy, {
        activityType: "ORDER_SHIPPED",
        document: { confirmedShipDate: "2026-08-31" }
    }, [], false), false);
    assert.equal(shouldSendWarehouseBillingActivityEmail(alconaPolicy, {
        activityType: "ORDER_SHIPPED",
        document: { confirmedShipDate: "2026-09-01" }
    }, [], false), true);
    assert.equal(shouldSendWarehouseBillingActivityEmail(null, {
        activityType: "ORDER_SHIPPED",
        document: { confirmedShipDate: "2026-09-01" }
    }, [], false), false);
});

test("billing activity uses the operational service date", () => {
    assert.equal(getWarehouseBillingActivityServiceDate({
        activityType: "ORDER_SHIPPED",
        document: { confirmedShipDate: "2026-09-02", shippedAt: "2026-09-04T12:00:00Z" }
    }, []), "2026-09-02");
    assert.equal(getWarehouseBillingActivityServiceDate({
        activityType: "INBOUND_RECEIVED",
        document: { receivedAt: "2026-09-03T15:00:00Z" }
    }, []), "2026-09-03");
});

test("initial inbound storage follows actual pallet sizes", () => {
    const rollups = buildPortalInboundInitialStorageBillingRollups({
        lines: [{ id: "1", trackingLevel: "CASE" }],
        receiptAllocations: [
            { lineId: "1", palletReference: "P1", palletSizeType: "STANDARD_40_48_55" },
            { lineId: "1", palletReference: "P2", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "1", palletReference: "P3", palletSizeType: "NON_STANDARD" }
        ]
    });
    assert.deepEqual(Object.fromEntries(rollups.map((row) => [row.feeCode, row.quantity])), {
        STANDARD_PALLET_STORAGE: 1,
        OVERSIZED_PALLET_STORAGE: 1,
        NON_STANDARD_PALLET_STORAGE: 1
    });
});

test("enabled company policy adds initial storage to inbound billing", async () => {
    const client = createBillingClient({
        PALLET_RECEIVING_FEE: 6,
        PUT_AWAY_PALLET: 2,
        STANDARD_PALLET_STORAGE: 17
    });
    const created = await createPortalInboundBillingEvents(client, {
        id: 901,
        inboundCode: "INB-TEST-901",
        accountName: "ALCONA TRADING LTD",
        receivedAt: "2026-09-01T13:00:00Z",
        lines: [{ id: "1", sku: "PALLET-SKU", trackingLevel: "PALLET", receivedQuantity: 2 }],
        palletLabels: []
    }, { billingPolicy: alconaPolicy });
    assert.deepEqual(created.map((event) => event.feeCode).sort(), [
        "PALLET_RECEIVING_FEE",
        "PUT_AWAY_PALLET",
        "STANDARD_PALLET_STORAGE"
    ]);
    assert.equal(created.find((event) => event.feeCode === "STANDARD_PALLET_STORAGE").amount, 34);
});

test("outbound billing records confirmed ship date instead of processing date", async () => {
    const client = createBillingClient({ SHIPPING_ADMINISTRATION_FEE: 5, PALLET_PICK_FEE: 6 });
    const created = await createPortalOrderBillingEvents(client, {
        id: 902,
        orderCode: "ORD-TEST-902",
        accountName: "TEST COMPANY",
        confirmedShipDate: "2026-09-02",
        shippedAt: "2026-09-04T13:00:00Z",
        lines: [{ id: "1", sku: "PALLET-SKU", trackingLevel: "PALLET", quantity: 4 }],
        shipmentLines: []
    });
    assert.ok(created.length > 0);
    assert.deepEqual([...new Set(created.map((event) => event.serviceDate))], ["2026-09-02"]);
});
