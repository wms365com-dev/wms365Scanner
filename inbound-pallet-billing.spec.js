const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_PALLET_SIZE_TYPES,
    portalPalletSizeInboundBillingCode,
    buildPortalInboundPalletBillingRollups,
    createPortalInboundBillingEvents,
    sanitizePortalInboundReceivingInput
} = require("./server");

function rollupsByFee(rollups) {
    return Object.fromEntries(
        rollups
            .map((rollup) => [rollup.feeCode, rollup.quantity])
            .sort(([left], [right]) => left.localeCompare(right))
    );
}

function createMockBillingClient(enabledFees = {}) {
    const events = [];
    const feeRows = {
        INBOUND_PROCESSING_FEE: {
            code: "INBOUND_PROCESSING_FEE",
            category: "Receiving / Inbound Handling",
            name: "Inbound processing fee",
            unit_label: "per receipt"
        },
        PALLET_RECEIVING_FEE: {
            code: "PALLET_RECEIVING_FEE",
            category: "Receiving / Inbound Handling",
            name: "Pallet receiving fee",
            unit_label: "per pallet"
        },
        OVERSIZED_PALLET_INBOUND: {
            code: "OVERSIZED_PALLET_INBOUND",
            category: "Receiving / Inbound Handling",
            name: "Oversized pallet inbound",
            unit_label: "per pallet"
        },
        NON_STANDARD_PALLET_INBOUND: {
            code: "NON_STANDARD_PALLET_INBOUND",
            category: "Receiving / Inbound Handling",
            name: "Non-standard pallet inbound",
            unit_label: "per pallet"
        },
        PUT_AWAY_PALLET: {
            code: "PUT_AWAY_PALLET",
            category: "Put Away",
            name: "Put-away fee",
            unit_label: "per pallet"
        },
        CARTON_RECEIVING_FEE: {
            code: "CARTON_RECEIVING_FEE",
            category: "Receiving / Inbound Handling",
            name: "Carton receiving fee",
            unit_label: "per carton"
        },
        PUT_AWAY_CARTON: {
            code: "PUT_AWAY_CARTON",
            category: "Put Away",
            name: "Put-away fee",
            unit_label: "per carton"
        }
    };

    return {
        events,
        async query(sql, params = []) {
            if (String(sql).includes("from billing_fee_catalog")) {
                const feeCode = params[1];
                const base = feeRows[feeCode];
                if (!base) return { rowCount: 0, rows: [] };
                const enabled = Object.prototype.hasOwnProperty.call(enabledFees, feeCode);
                return {
                    rowCount: 1,
                    rows: [{
                        ...base,
                        default_rate: 0,
                        is_active: true,
                        owner_rate: enabled ? enabledFees[feeCode] : null,
                        owner_enabled: enabled,
                        owner_unit_label: base.unit_label,
                        owner_note: ""
                    }]
                };
            }

            if (String(sql).includes("insert into billing_events")) {
                const [
                    eventKey,
                    accountName,
                    feeCode,
                    feeCategory,
                    feeName,
                    unitLabel,
                    quantity,
                    rate,
                    amount,
                    currencyCode,
                    serviceDate,
                    sourceType,
                    sourceRef,
                    reference,
                    note,
                    metadata
                ] = params;
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
                    invoice_number: "",
                    invoiced_at: null,
                    source_type: sourceType,
                    source_ref: sourceRef,
                    reference,
                    note,
                    metadata: JSON.parse(metadata || "{}"),
                    created_at: new Date("2026-07-24T12:00:00Z"),
                    updated_at: new Date("2026-07-24T12:00:00Z")
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

test("pallet size maps to the correct inbound receiving billing code", () => {
    assert.equal(
        portalPalletSizeInboundBillingCode(PORTAL_PALLET_SIZE_TYPES.STANDARD_40_48_55),
        "PALLET_RECEIVING_FEE"
    );
    assert.equal(
        portalPalletSizeInboundBillingCode(PORTAL_PALLET_SIZE_TYPES.OVERSIZE_40_48_85),
        "OVERSIZED_PALLET_INBOUND"
    );
    assert.equal(
        portalPalletSizeInboundBillingCode(PORTAL_PALLET_SIZE_TYPES.NON_STANDARD),
        "NON_STANDARD_PALLET_INBOUND"
    );
});

test("pallet-tracked inbound billing uses pallet label size counts", () => {
    const inbound = {
        lines: [
            { id: "1", sku: "STD", trackingLevel: "PALLET" },
            { id: "2", sku: "OVR", trackingLevel: "PALLET" },
            { id: "3", sku: "NON", trackingLevel: "PALLET" }
        ],
        palletLabels: [
            { lineId: "1", palletSizeType: "STANDARD_40_48_55" },
            { lineId: "1", palletSizeType: "STANDARD_40_48_55" },
            { lineId: "2", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "2", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "2", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "2", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "2", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "3", palletSizeType: "NON_STANDARD" },
            { lineId: "3", palletSizeType: "NON_STANDARD" },
            { lineId: "3", palletSizeType: "NON_STANDARD" }
        ]
    };

    assert.deepEqual(rollupsByFee(buildPortalInboundPalletBillingRollups(inbound, 10)), {
        NON_STANDARD_PALLET_INBOUND: 3,
        OVERSIZED_PALLET_INBOUND: 5,
        PALLET_RECEIVING_FEE: 2,
        PUT_AWAY_PALLET: 10
    });
});

test("pallet-tracked inbound billing falls back to standard pallets when labels are missing", () => {
    const inbound = {
        lines: [
            { id: "1", sku: "ARP34-37-BLK", trackingLevel: "PALLET" }
        ],
        palletLabels: []
    };

    assert.deepEqual(rollupsByFee(buildPortalInboundPalletBillingRollups(inbound, 2)), {
        PALLET_RECEIVING_FEE: 2,
        PUT_AWAY_PALLET: 2
    });
});

test("carton-tracked pallet labels do not change carton receiving billing", () => {
    const inbound = {
        lines: [
            { id: "1", sku: "CASE-SKU", trackingLevel: "CASE" }
        ],
        palletLabels: [
            { lineId: "1", palletSizeType: "OVERSIZE_40_48_85" }
        ]
    };

    assert.deepEqual(buildPortalInboundPalletBillingRollups(inbound, 0), []);
});

test("actual receipt pallets are billed by physical pallet size for case-tracked stock", () => {
    const inbound = {
        lines: [{ id: "1", sku: "CASE-SKU", trackingLevel: "CASE" }],
        palletLabels: [],
        receiptAllocations: [
            { lineId: "1", quantity: 6, palletReference: "Pallet 1", palletSizeType: "STANDARD_40_48_55" },
            { lineId: "1", quantity: 6, palletReference: "Pallet 2", palletSizeType: "OVERSIZE_40_48_85" }
        ]
    };
    assert.deepEqual(rollupsByFee(buildPortalInboundPalletBillingRollups(inbound, 0)), {
        OVERSIZED_PALLET_INBOUND: 1,
        PALLET_RECEIVING_FEE: 1,
        PUT_AWAY_PALLET: 2
    });
});

test("receiving input preserves multiple location and pallet allocations for one PO line", () => {
    const inbound = {
        fulfillmentLocationCode: "WHS01",
        lines: [{ id: 10, sku: "32055", quantity: 12, trackingLevel: "UNIT", lotTracked: false, expirationTracked: false }]
    };
    const allocations = sanitizePortalInboundReceivingInput({
        receivingLines: [
            { id: 10, receivedQuantity: 5, receivedLocation: "WHS01-A01", palletReference: "Pallet 1", palletSizeType: "STANDARD_40_48_55" },
            { id: 10, receivedQuantity: 7, receivedLocation: "WHS01-B02", palletReference: "Pallet 2", palletSizeType: "OVERSIZE_40_48_85" }
        ]
    }, inbound);
    assert.equal(allocations.length, 2);
    assert.deepEqual(allocations.map((entry) => [entry.receivedQuantity, entry.receivedLocation, entry.palletReference]), [
        [5, "WHS01-A01", "Pallet 1"],
        [7, "WHS01-B02", "Pallet 2"]
    ]);
});

test("receiving input preserves optional pallet weight and unit", () => {
    const inbound = {
        fulfillmentLocationCode: "WHS01",
        lines: [{ id: 10, sku: "MS26060402G", quantity: 1, trackingLevel: "PALLET", lotTracked: false, expirationTracked: false }]
    };
    const [allocation] = sanitizePortalInboundReceivingInput({
        receivingLines: [{
            id: 10,
            receivedQuantity: 1,
            receivedLocation: "WHS01-A01",
            palletReference: "Pallet 1",
            palletSizeType: "STANDARD_40_48_55",
            palletWeight: 1245.5,
            palletWeightUom: "LB"
        }]
    }, inbound);
    assert.equal(allocation.palletWeight, 1245.5);
    assert.equal(allocation.palletWeightUom, "LB");
});

test("receiving input allows blank pallet weight and rejects weight without a pallet reference", () => {
    const inbound = {
        fulfillmentLocationCode: "WHS01",
        lines: [{ id: 10, sku: "MS26060402G", quantity: 1, trackingLevel: "PALLET", lotTracked: false, expirationTracked: false }]
    };
    const [blankWeight] = sanitizePortalInboundReceivingInput({
        receivingLines: [{ id: 10, receivedQuantity: 1, receivedLocation: "WHS01-A01", palletReference: "Pallet 1" }]
    }, inbound);
    assert.equal(blankWeight.palletWeight, null);
    assert.throws(() => sanitizePortalInboundReceivingInput({
        receivingLines: [{ id: 10, receivedQuantity: 1, receivedLocation: "WHS01-A01", palletWeight: 800, palletWeightUom: "KG" }]
    }, inbound), /Enter a pallet reference before adding pallet weight/);
});

test("portal inbound billing creates enabled processing, receiving, and put-away charges on the received date", async () => {
    const client = createMockBillingClient({
        INBOUND_PROCESSING_FEE: 5,
        OVERSIZED_PALLET_INBOUND: 10,
        PUT_AWAY_PALLET: 2
    });
    const inbound = {
        id: 126,
        inboundCode: "INB-000126",
        accountName: "EVEROLL INDUSTRIES LTD",
        referenceNumber: "HMMU5501197",
        receivedAt: "2026-07-22T16:00:00.000Z",
        expectedDate: "2026-07-20",
        lines: [
            { id: "1", sku: "ARP34-37-BLK", trackingLevel: "PALLET", receivedQuantity: 10 }
        ],
        palletLabels: Array.from({ length: 10 }, () => ({ lineId: "1", palletSizeType: "OVERSIZE_40_48_85" }))
    };

    const created = await createPortalInboundBillingEvents(client, inbound);
    const byFee = Object.fromEntries(created.map((event) => [event.feeCode, event]));

    assert.equal(created.length, 3);
    assert.equal(byFee.INBOUND_PROCESSING_FEE.quantity, 1);
    assert.equal(byFee.INBOUND_PROCESSING_FEE.amount, 5);
    assert.equal(byFee.OVERSIZED_PALLET_INBOUND.quantity, 10);
    assert.equal(byFee.OVERSIZED_PALLET_INBOUND.amount, 100);
    assert.equal(byFee.PUT_AWAY_PALLET.quantity, 10);
    assert.equal(byFee.PUT_AWAY_PALLET.amount, 20);
    assert.deepEqual([...new Set(created.map((event) => event.serviceDate))], ["2026-07-22"]);
    assert.deepEqual([...new Set(created.map((event) => event.sourceRef))], ["INB-000126"]);
});

test("portal inbound billing does not create disabled optional processing or put-away charges", async () => {
    const client = createMockBillingClient({
        OVERSIZED_PALLET_INBOUND: 10
    });
    const inbound = {
        id: 127,
        inboundCode: "INB-000127",
        accountName: "EVEROLL INDUSTRIES LTD",
        referenceNumber: "HMMU5501198",
        receivedAt: "2026-07-22T16:00:00.000Z",
        lines: [
            { id: "1", sku: "ARP34-38-BLK", trackingLevel: "PALLET", receivedQuantity: 2 }
        ],
        palletLabels: [
            { lineId: "1", palletSizeType: "OVERSIZE_40_48_85" },
            { lineId: "1", palletSizeType: "OVERSIZE_40_48_85" }
        ]
    };

    const created = await createPortalInboundBillingEvents(client, inbound);

    assert.deepEqual(created.map((event) => event.feeCode), ["OVERSIZED_PALLET_INBOUND"]);
    assert.equal(created[0].quantity, 2);
    assert.equal(created[0].amount, 20);
    assert.equal(created[0].serviceDate, "2026-07-22");
});

test("portal inbound billing falls back to expected date when received date is missing", async () => {
    const client = createMockBillingClient({
        PALLET_RECEIVING_FEE: 6
    });
    const inbound = {
        id: 128,
        inboundCode: "INB-000128",
        accountName: "STANDARD PALLET CUSTOMER",
        referenceNumber: "REF-128",
        expectedDate: "2026-08-03",
        lines: [
            { id: "1", sku: "STD-PALLET", trackingLevel: "PALLET", quantity: 4 }
        ],
        palletLabels: []
    };

    const created = await createPortalInboundBillingEvents(client, inbound);

    assert.deepEqual(created.map((event) => event.feeCode), ["PALLET_RECEIVING_FEE"]);
    assert.equal(created[0].serviceDate, "2026-08-03");
    assert.equal(created[0].amount, 24);
});
