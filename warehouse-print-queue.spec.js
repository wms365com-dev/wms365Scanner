const test = require("node:test");
const assert = require("node:assert/strict");

const {
    WAREHOUSE_PRINT_JOB_STATUSES,
    WAREHOUSE_PRINTER_ROLES,
    normalizeWarehousePrinterRole,
    normalizeWarehousePrintJobStatus,
    hashWarehousePrintStationToken,
    mapWarehousePrintJobRow,
    buildPortalOrderPackingSlipPdfAttachment
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
