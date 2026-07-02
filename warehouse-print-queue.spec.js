const test = require("node:test");
const assert = require("node:assert/strict");

const {
    WAREHOUSE_PRINT_JOB_STATUSES,
    WAREHOUSE_PRINTER_ROLES,
    normalizeWarehousePrinterRole,
    normalizeWarehousePrintJobStatus,
    hashWarehousePrintStationToken,
    mapWarehousePrintJobRow,
    buildPortalOrderPackingSlipPdfAttachment,
    buildPortalOrderBatchPickTicketPdfAttachment,
    buildPortalOrderUcc128LabelPdfAttachment,
    buildSscc18,
    calculateGs1Modulo10CheckDigit
} = require("./server");

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
            lines: [{ sku: "10125001", quantity: 4, trackingLevel: "CASE", description: "Portable Fire Pit - Matte Black" }]
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
            lines: [{ sku: "10125001", quantity: 4, trackingLevel: "CASE", description: "Portable Fire Pit - Matte Black" }]
        }
    ]);

    assert.equal(attachment.contentType, "application/pdf");
    assert.match(attachment.filename, /batch-pick-tickets-2-orders\.pdf$/);
    const pdfText = attachment.content.toString("utf8");
    assert.match(pdfText, /ORD-000354/);
    assert.match(pdfText, /ORD-000355/);
});
