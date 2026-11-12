const test = require("node:test");
const assert = require("node:assert/strict");

const {
    WAREHOUSE_PRINT_JOB_STATUSES,
    WAREHOUSE_PRINTER_ROLES,
    normalizeWarehousePrinterRole,
    normalizeWarehousePrintJobStatus,
    warehousePrintAgentSupportsDurableReceipts,
    hashWarehousePrintStationToken,
    mapWarehousePrintJobRow,
    buildPortalOrderPackingSlipPdfAttachment,
    buildPortalOrderBatchPickTicketPdfAttachment,
    buildPortalOrderUcc128LabelPdfAttachment,
    buildSscc18,
    calculateGs1Modulo10CheckDigit
} = require("./server");
const { enrollWarehousePrintConnector, syncConnectorPrinterMappings, claimNextWarehousePrintJob } = require("./server");
const { requireWarehousePrintAgent, completeWarehousePrintJob } = require("./server");
const { findPendingWarehouseDocumentPrint } = require("./server");
const { resolveWarehousePrinterForJob } = require("./server");
test("label jobs require an exact label printer role even with an explicit printer id", async () => {
    const queries = [];
    const client = { query: async (sql, params) => {
        queries.push({ sql, params });
        return { rowCount: 0, rows: [] };
    } };
    await assert.rejects(resolveWarehousePrinterForJob(client, {
        fulfillmentLocationId: 1, printerId: 17, documentType: "SHIPPING_LABEL"
    }), /No active warehouse printer/);
    assert.match(queries[0].sql, /p\.printer_type = 'LABEL'/);
    assert.match(queries[0].sql, /p\.printer_role = \$2/);
    assert.deepEqual(queries[0].params.slice(0, 2), [17, "SHIPPING_LABEL"]);
});

test("pick tickets cannot fall back to a label printer or unrelated document role", async () => {
    let query;
    const client = { query: async (sql, params) => {
        query = { sql, params };
        return { rowCount: 0, rows: [] };
    } };
    await assert.rejects(resolveWarehousePrinterForJob(client, {
        fulfillmentLocationId: 1, documentType: "PICK_TICKET"
    }), /No active warehouse printer/);
    assert.match(query.sql, /p\.printer_type = 'DOCUMENT'/);
    assert.match(query.sql, /p\.printer_role in \(\$2, 'GENERAL'\)/);
    assert.deepEqual(query.params.slice(0, 2), [1, "PICK_TICKET"]);
});

test("repeated print requests reuse a pending exact document without another copy", async () => {
    const content = Buffer.from("%PDF test"); let writes = 0;
    const client = { query: async (sql) => { if (sql.startsWith("select *")) return { rows: [{ id: 9, status: "QUEUED", payload_base64: content.toString("base64") }] }; if (sql.startsWith("update")) writes++; return { rows: [] }; } };
    const result = await findPendingWarehouseDocumentPrint(client, { order: { id: 2, accountName: "TEST COMPANY" }, fulfillmentLocationId: 7, printer: { id: 3 }, documentType: "PICK_TICKET", attachment: { content } });
    assert.equal(result.id, 9); assert.equal(writes, 0);
});

test("changed document cannot create another copy while the earlier version prints", async () => {
    const client = { query: async (sql) => ({ rows: sql.startsWith("select *") ? [{ id: 9, status: "CLAIMED", payload_base64: "old" }] : [] }) };
    await assert.rejects(findPendingWarehouseDocumentPrint(client, { order: { id: 2, accountName: "TEST COMPANY" }, fulfillmentLocationId: 7, printer: { id: 3 }, documentType: "PICK_TICKET", attachment: { content: Buffer.from("new") } }), /earlier version/);
});

test("an updated document replaces only a not-yet-claimed queued copy", async () => {
    const calls = [];
    const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: sql.startsWith("select *") ? [{ id: 9, status: "QUEUED", payload_base64: "old" }] : [] }; } };
    assert.equal(await findPendingWarehouseDocumentPrint(client, { order: { id: 2, accountName: "TEST COMPANY" }, fulfillmentLocationId: 7, printer: { id: 3 }, documentType: "PICK_TICKET", attachment: { content: Buffer.from("new") }, actor: "TEST" }), null);
    assert.ok(calls.some((call) => call.sql.includes("status = 'CANCELLED'") && call.params[0] === 9));
    assert.ok(calls.some((call) => call.params?.includes("SUPERSEDED")));
});

test("disabled user loses print-agent access even with a valid station token", async () => {
    let calls = 0;
    const client = { query: async () => {
        calls++;
        return calls === 1 ? { rowCount: 1, rows: [{ id: 23, app_user_id: 40, fulfillment_location_id: 7 }] } : { rowCount: 1, rows: [{ id: 40, is_active: false }] };
    } };
    await assert.rejects(requireWarehousePrintAgent({ headers: { authorization: "Bearer test" } }, client), /no longer authorized/);
});

test("completion cannot expose another station, warehouse, or customer job", async () => {
    let query;
    await assert.rejects(completeWarehousePrintJob({ query: async (sql, params) => { query = { sql, params }; return { rows: [], rowCount: 0 }; } }, {
        id: 23, fulfillment_location_id: 7, accessibleCompanies: ["TEST COMPANY"]
    }, 99, { success: true }), /could not be found/);
    assert.deepEqual(query.params, [99, 23, 7, ["TEST COMPANY"]]);
    assert.match(query.sql, /station_id = \$2/);
    assert.match(query.sql, /account_name = any/);
});

test("connector enrollment rejects a warehouse outside the user's assignments before writing", async () => {
    let queries = 0;
    await assert.rejects(enrollWarehousePrintConnector({ query: async () => { queries++; throw new Error("Unexpected query"); } }, {
        id: 40, role: "warehouse_worker", is_active: true, assignedFulfillmentLocations: [{ id: 7 }]
    }, { fulfillmentLocationId: 8, installationId: "00000000-0000-4000-8000-000000000001" }), /Access restricted/);
    assert.equal(queries, 0);
});

test("customer and inactive accounts cannot register warehouse print stations", async () => {
    const client = { query: async () => { throw new Error("Must not write"); } };
    await assert.rejects(enrollWarehousePrintConnector(client, { id: 3, role: "customer_portal_user", is_active: true }, {}), /warehouse account/);
    await assert.rejects(enrollWarehousePrintConnector(client, { id: 3, role: "warehouse_worker", is_active: false }, {}), /active warehouse account/);
});

test("connector registration is bound to user, installation, and warehouse", async () => {
    const { generateIdentity, createProof } = require("./print-agent/connector-security");
    const input = { fulfillmentLocationId: 7, installationId: "00000000-0000-4000-8000-000000000001", hostName: "TEST-PC" };
    const rawBody = Buffer.from(JSON.stringify(input));
    const dpop = await createProof({ identity: await generateIdentity(), url: "https://app.wms365.co/api/app/print-connector/enroll", body: rawBody, installationId: input.installationId });
    const calls = [];
    const client = { query: async (sql, parameters) => {
        calls.push({ sql, parameters });
        if (sql.startsWith("select * from warehouse_print_stations")) return { rowCount: 0, rows: [] };
        if (sql.includes("insert into warehouse_print_stations")) return { rowCount: 1, rows: [{ id: 23, station_code: parameters[0], fulfillment_location_id: parameters[2] }] };
        return { rowCount: 1, rows: [{ id: 7, created_at: new Date("2026-09-16T12:00:00Z") }] };
    } };
    const result = await enrollWarehousePrintConnector(client, { id: 40, role: "warehouse_worker", is_active: true, assignedFulfillmentLocations: [{ id: 7 }] }, input, { method: "POST", path: "/api/app/print-connector/enroll", headers: { dpop }, rawBody });
    assert.match(result.station.stationCode, /^CONNECT-40-7-/);
    assert.match(result.setupToken, /^wms365ps_/);
    assert.ok(calls.some((call) => call.sql.includes("set app_user_id") && call.parameters[1] === 40));
    assert.equal(result.tokenType, "DPoP");
    assert.ok(calls.some(call => call.sql.includes("device_key_thumbprint") && call.parameters[3] === input.installationId));
});

test("connector cannot register a printer absent from its installed device list", async () => {
    await assert.rejects(syncConnectorPrinterMappings({ query: async () => {} }, { id: 23, station_code: "TEST", app_user_id: 40, fulfillment_location_id: 7 }, {
        localPrinters: [{ name: "TEST LETTER" }], printerMappings: { PICK_TICKET: "OTHER PRINTER" }
    }), /not installed/);
});

test("printer discovery updates only this station and never changes warehouse defaults", async () => {
    const calls = [];
    await syncConnectorPrinterMappings({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } }, {
        id: 23, station_code: "TEST", app_user_id: 40, fulfillment_location_id: 7
    }, { localPrinters: [{ name: "TEST LETTER" }], printerMappings: { PICK_TICKET: "TEST LETTER" } });
    const insert = calls.find((call) => call.sql.includes("insert into warehouse_printers"));
    assert.equal(insert.params[0], 7); assert.equal(insert.params[1], 23);
    assert.match(insert.sql, /warehouse_printers.station_id = excluded.station_id/);
    assert.doesNotMatch(insert.sql, /is_default/);
});

test("print claims are filtered by station, warehouse, and customer and claim only one job", async () => {
    let claim;
    const client = { query: async (sql, params) => { if (sql.includes("with next_jobs")) claim = { sql, params }; return { rows: [] }; } };
    await claimNextWarehousePrintJob(client, { id: 23, fulfillment_location_id: 7, accessibleCompanies: ["TEST COMPANY"], agent_version: "1.2.0" }, { limit: 5 });
    assert.deepEqual(claim.params, [23, 1, 7, ["TEST COMPANY"]]);
    assert.match(claim.sql, /fulfillment_location_id = \$3/);
    assert.match(claim.sql, /account_name = any\(\$4::text\[\]\)/);
});

test("warehouse printer roles normalize common document labels", () => {
    assert.equal(normalizeWarehousePrinterRole("pick"), WAREHOUSE_PRINTER_ROLES.PICK_TICKET);
    assert.equal(normalizeWarehousePrinterRole("packing slip"), WAREHOUSE_PRINTER_ROLES.PACKING_SLIP);
    assert.equal(normalizeWarehousePrinterRole("shipping-label"), WAREHOUSE_PRINTER_ROLES.SHIPPING_LABEL);
    assert.equal(normalizeWarehousePrinterRole("pallet"), WAREHOUSE_PRINTER_ROLES.PALLET_LABEL);
    assert.equal(normalizeWarehousePrinterRole("unknown"), WAREHOUSE_PRINTER_ROLES.GENERAL);
});

test("warehouse print job statuses normalize safely", () => {
    assert.equal(normalizeWarehousePrintJobStatus("printed"), WAREHOUSE_PRINT_JOB_STATUSES.PRINTED);
    assert.equal(normalizeWarehousePrintJobStatus("bad-status"), WAREHOUSE_PRINT_JOB_STATUSES.QUEUED);
});

test("stale print recovery is only enabled for agents with durable local receipts", () => {
    assert.equal(warehousePrintAgentSupportsDurableReceipts("0.1.0"), false);
    assert.equal(warehousePrintAgentSupportsDurableReceipts(""), false);
    assert.equal(warehousePrintAgentSupportsDurableReceipts("1.0.0"), false);
    assert.equal(warehousePrintAgentSupportsDurableReceipts("1.1.0"), false);
    assert.equal(warehousePrintAgentSupportsDurableReceipts("1.2.0"), true);
    assert.equal(warehousePrintAgentSupportsDurableReceipts("1.4.2-beta"), true);
    assert.equal(warehousePrintAgentSupportsDurableReceipts("2.0.0"), true);
});

test("warehouse print station token hashing is deterministic and not raw token", () => {
    const token = "wms365ps_test_token";
    const hash = hashWarehousePrintStationToken(token);
    assert.equal(hash, hashWarehousePrintStationToken(token));
    assert.notEqual(hash, token);
    assert.equal(hash.length, 64);
});

test("warehouse print job mapping only exposes payload to the agent path", () => {
    const row = {
        id: 55,
        fulfillment_location_id: 9,
        station_id: 3,
        printer_id: 7,
        document_type: "PICK_TICKET",
        document_title: "pick ticket ORD-TEST",
        source_type: "PORTAL_ORDER",
        source_id: "101",
        source_ref: "ORD-TEST",
        account_name: "TEST COMPANY",
        payload_type: "PDF",
        content_type: "application/pdf",
        file_name: "pick.pdf",
        payload_base64: "JVBERi0xLjQ=",
        status: "QUEUED",
        requested_by: "Worker",
        attempts: 0,
        max_attempts: 5
    };

    assert.equal(mapWarehousePrintJobRow(row).payloadBase64, undefined);
    assert.equal(mapWarehousePrintJobRow(row, { includePayload: true }).payloadBase64, "JVBERi0xLjQ=");
});

test("packing slip print payload is generated as a PDF attachment", () => {
    const attachment = buildPortalOrderPackingSlipPdfAttachment({
        orderCode: "ORD-TEST",
        accountName: "TEST COMPANY",
        lines: [{ sku: "SKU-1", quantity: 2, trackingLevel: "CASE", description: "Test item" }]
    });

    assert.equal(attachment.contentType, "application/pdf");
    assert.match(attachment.filename, /packing-slip\.pdf$/);
    assert.ok(Buffer.isBuffer(attachment.content));
    assert.match(attachment.content.toString("utf8", 0, 8), /%PDF-1\.4/);
});

test("SSCC check digit and generated value are stable", () => {
    assert.equal(calculateGs1Modulo10CheckDigit("08500724510000001"), "1");
    assert.equal(buildSscc18({
        companyPrefix: "850072451",
        serialSeed: "1",
        extensionDigit: "0"
    }), "085007245100000011");
});

test("Pack Fire UCC128 labels generate as PDF with SSCC text", () => {
    const attachment = buildPortalOrderUcc128LabelPdfAttachment({
        id: 353,
        orderCode: "ORD-000353",
        accountName: "PACKFIRE",
        poNumber: "PO-20260621-01",
        shipToName: "Go Overland Canada",
        shipToAddress1: "1435 Bonhill Rd #26",
        shipToCity: "Mississauga",
        shipToState: "ON",
        shipToPostalCode: "L5T 1V2",
        shipToCountry: "CA",
        lines: [{
            id: 1311,
            sku: "10125001",
            quantity: 2,
            trackingLevel: "CASE",
            description: "Portable Fire Pit - Matte Black",
            upc: "850072451008"
        }]
    }, {
        gs1CompanyPrefix: "850072451",
        labelsPerLine: 2
    });

    assert.equal(attachment.contentType, "application/pdf");
    assert.match(attachment.filename, /ucc128-labels\.pdf$/);
    assert.ok(Buffer.isBuffer(attachment.content));
    const pdfText = attachment.content.toString("utf8");
    assert.match(pdfText, /%PDF-1\.4/);
    assert.doesNotMatch(pdfText, /UCC128 \/ GS1-128 CARTON LABEL/);
    assert.match(pdfText, /Pack Fire c\/o Grey Wolf 3PL & Logistics Inc/);
    assert.match(pdfText, /\\\(00\\\) 085007245/);
});

test("batch pick tickets combine selected orders into one PDF", () => {
    const attachment = buildPortalOrderBatchPickTicketPdfAttachment([
        {
            id: 354,
            orderCode: "ORD-000354",
            accountName: "PACKFIRE",
            status: "RELEASED",
            poNumber: "PO00400252",
            requestedShipDate: "2026-05-29",
            shipToName: "SAIL",
            shipToAddress1: "Customer DC",
            lines: [{ sku: "10125001", quantity: 4, trackingLevel: "CASE", description: "Portable Fire Pit - Matte Black", pickLocations: [{ location: "PACKFIRE-A01", quantity: 4, trackingLevel: "CASE" }] }]
        },
        {
            id: 355,
            orderCode: "ORD-000355",
            accountName: "PACKFIRE",
            status: "RELEASED",
            poNumber: "PO00400253",
            requestedShipDate: "2026-05-29",
            shipToName: "SAIL",
            shipToAddress1: "Customer DC",
            lines: [{ sku: "10125001", quantity: 4, trackingLevel: "CASE", description: "Portable Fire Pit - Matte Black", pickLocations: [{ location: "PACKFIRE-A02", quantity: 4, trackingLevel: "CASE" }] }]
        }
    ]);

    assert.equal(attachment.contentType, "application/pdf");
    assert.match(attachment.filename, /batch-pick-tickets-2-orders\.pdf$/);
    const pdfText = attachment.content.toString("utf8");
    assert.match(pdfText, /ORD-000354/);
    assert.match(pdfText, /ORD-000355/);
});
