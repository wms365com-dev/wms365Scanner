const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PORTAL_ORDER_PRINT_DOCUMENT_TYPES,
    normalizePortalOrderPrintDocumentType,
    mapPortalOrderPrintSummaryRows,
    recordPortalOrderPrintEvent
} = require("./server");

function createPrintEventClient({ existingCount = 0 } = {}) {
    const calls = [];
    let insertedAction = "";
    return {
        calls,
        async query(sql, params = []) {
            calls.push({ sql, params });
            if (/select id,\s*account_name,\s*order_code,\s*status from portal_orders/i.test(sql)) {
                return {
                    rowCount: 1,
                    rows: [{
                        id: params[0],
                        account_name: "TEST COMPANY",
                        order_code: "ORD-TEST",
                        status: "RELEASED"
                    }]
                };
            }
            if (/select count\(\*\)::integer as print_count from portal_order_print_events/i.test(sql)) {
                return { rows: [{ print_count: existingCount }] };
            }
            if (/insert into portal_order_print_events/i.test(sql)) {
                insertedAction = params[2];
                return { rows: [] };
            }
            if (/from portal_order_print_events/i.test(sql)) {
                return {
                    rows: [{
                        order_id: params[0][0],
                        document_type: params[0][0] ? PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PICK_TICKET : "",
                        print_count: existingCount + 1,
                        last_print_action: insertedAction,
                        last_printed_by: "Worker User",
                        last_printed_at: new Date("2026-06-12T14:30:00.000Z")
                    }]
                };
            }
            if (/insert into activity_log/i.test(sql)) {
                return { rows: [{ id: 1, type: params[0], title: params[1], details: params[2], created_at: new Date() }] };
            }
            throw new Error(`Unexpected SQL in print event test: ${sql}`);
        }
    };
}

test("portal order print document types normalize warehouse labels", () => {
    assert.equal(normalizePortalOrderPrintDocumentType("pick"), PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PICK_TICKET);
    assert.equal(normalizePortalOrderPrintDocumentType("pick ticket"), PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PICK_TICKET);
    assert.equal(normalizePortalOrderPrintDocumentType("PACKING-SLIP"), PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PACKING_SLIP);
    assert.equal(normalizePortalOrderPrintDocumentType("packing"), PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PACKING_SLIP);
    assert.equal(normalizePortalOrderPrintDocumentType("invoice"), "");
});

test("portal order print summaries include counts and latest print details", () => {
    const printedAt = new Date("2026-06-12T14:30:00.000Z");
    const summary = mapPortalOrderPrintSummaryRows([
        {
            document_type: "PICK_TICKET",
            print_count: 2,
            last_print_action: "REPRINT",
            last_printed_by: "worker@example.com",
            last_printed_at: printedAt
        }
    ]);

    assert.deepEqual(summary.PICK_TICKET, {
        documentType: PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PICK_TICKET,
        printCount: 2,
        lastPrintAction: "REPRINT",
        lastPrintedBy: "worker@example.com",
        lastPrintedAt: printedAt.toISOString()
    });
    assert.deepEqual(summary.PACKING_SLIP, {
        documentType: PORTAL_ORDER_PRINT_DOCUMENT_TYPES.PACKING_SLIP,
        printCount: 0,
        lastPrintAction: "",
        lastPrintedBy: "",
        lastPrintedAt: null
    });
});

test("first portal order print is recorded as PRINT with count one", async () => {
    const client = createPrintEventClient({ existingCount: 0 });
    const result = await recordPortalOrderPrintEvent(
        client,
        101,
        "pick",
        { full_name: "Worker User", email: "worker@example.com" }
    );

    assert.equal(result.printEvent.printAction, "PRINT");
    assert.equal(result.printEvent.printCount, 1);
    assert.equal(result.printEvent.printedBy, "Worker User");
    assert.ok(client.calls.some((call) => /insert into portal_order_print_events/i.test(call.sql)));
    assert.ok(client.calls.some((call) => /insert into activity_log/i.test(call.sql) && /Printed pick ticket/.test(call.params[1])));
});

test("subsequent portal order print is recorded as REPRINT", async () => {
    const client = createPrintEventClient({ existingCount: 1 });
    const result = await recordPortalOrderPrintEvent(
        client,
        101,
        "pick",
        { email: "worker@example.com" }
    );

    assert.equal(result.printEvent.printAction, "REPRINT");
    assert.equal(result.printEvent.printCount, 2);
    assert.equal(result.printEvent.printedBy, "worker@example.com");
    assert.ok(client.calls.some((call) => /insert into activity_log/i.test(call.sql) && /Reprinted pick ticket/.test(call.params[1])));
});
