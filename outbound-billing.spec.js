const test = require("node:test");
const assert = require("node:assert/strict");
const { createPortalOrderBillingEvents } = require("./server");

function createClient(enabledFees) {
    const events = [];
    return {
        events,
        async query(sql, params = []) {
            if (String(sql).includes("from billing_fee_catalog")) {
                const code = params[1];
                if (!Object.prototype.hasOwnProperty.call(enabledFees, code)) return { rowCount: 0, rows: [] };
                return { rowCount: 1, rows: [{
                    code, category: "Test", name: code, unit_label: "unit",
                    default_rate: 0, is_active: true, owner_rate: enabledFees[code],
                    owner_enabled: true, owner_unit_label: "unit", owner_note: ""
                }] };
            }
            if (String(sql).includes("select * from billing_events where event_key")) {
                const found = events.find((event) => event.event_key === params[0]);
                return found ? { rowCount: 1, rows: [found] } : { rowCount: 0, rows: [] };
            }
            if (String(sql).includes("insert into billing_events")) {
                const row = {
                    id: events.length + 1, event_key: params[0], account_name: params[1], fee_code: params[2],
                    fee_category: params[3], fee_name: params[4], unit_label: params[5], quantity: params[6],
                    rate: params[7], amount: params[8], currency_code: params[9], service_date: params[10],
                    source_type: params[11], source_ref: params[12], reference: params[13], note: params[14],
                    metadata: JSON.parse(params[15] || "{}"), status: "OPEN", created_at: new Date(), updated_at: new Date()
                };
                events.push(row);
                return { rowCount: 1, rows: [row] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    };
}

test("shipment completion emits configured operational billing events from actual facts", async () => {
    const enabled = Object.fromEntries([
        "SHIPPING_ADMINISTRATION_FEE", "CARTON_PICK_FEE", "ADDITIONAL_CARTON_PICK_FEE",
        "SHIPPING_LABEL_PRINTING", "BILL_OF_LADING_PREPARATION", "RUSH_ORDER_FEE",
        "CARRIER_BOOKING_COORDINATION", "FREIGHT_CHARGE", "SPECIAL_LABOUR"
    ].map((code) => [code, 1]));
    const client = createClient(enabled);
    const events = await createPortalOrderBillingEvents(client, {
        id: 77,
        orderCode: "ORD-000077",
        accountName: "TEST COMPANY",
        shipmentMethod: "LTL_FREIGHT",
        rushApproved: true,
        outboundFreightCost: 400,
        outboundLabourHours: 2.5,
        lines: [{ id: "1", sku: "SKU-1", quantity: 3, trackingLevel: "CASE" }],
        documents: [
            { documentCategory: "SHIPPING_LABEL" },
            { documentCategory: "SHIPMENT_BOL" }
        ]
    });
    const byCode = Object.fromEntries(events.map((event) => [event.feeCode, event]));
    for (const code of Object.keys(enabled)) assert.ok(byCode[code], `${code} was not created`);
    assert.equal(byCode.FREIGHT_CHARGE.quantity, 400);
    assert.equal(byCode.SPECIAL_LABOUR.quantity, 2.5);
});

test("disabled optional fees do not create billing events", async () => {
    const client = createClient({ SHIPPING_ADMINISTRATION_FEE: 7 });
    const events = await createPortalOrderBillingEvents(client, {
        id: 78, orderCode: "ORD-000078", accountName: "TEST COMPANY",
        shipmentMethod: "PARCEL", rushApproved: true, outboundFreightCost: 50,
        outboundLabourHours: 1, lines: [], documents: []
    });
    assert.deepEqual(events.map((event) => event.feeCode), ["SHIPPING_ADMINISTRATION_FEE"]);
});
