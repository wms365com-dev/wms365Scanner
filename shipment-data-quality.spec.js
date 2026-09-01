const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    classifyParcelTrackingReference,
    getShipmentMethodTrackingConflict,
    assertShipmentMethodMatchesTrackingReference,
    buildShipmentDataQualityFindingCandidates,
    groupShipmentDataQualityFindingsByWarehouse,
    buildShipmentDataQualityWarehouseEmailText,
    isShipmentDataQualityAuditDue
} = require("./server");

function shipment(overrides = {}) {
    return {
        order_id: 101,
        order_code: "ORD-TEST-101",
        account_name: "TEST COMPANY",
        shipment_id: 501,
        shipment_code: "SHP-TEST-501",
        fulfillment_location_id: 10,
        warehouse_code: "TEST-WH-A",
        warehouse_name: "Test Warehouse A",
        shipment_method: "PARCEL",
        carrier_name: "UPS",
        tracking_reference: "1ZV56D262022637037",
        bol_reference: "",
        total_pallets: 0,
        confirmed_ship_date: "2026-08-31",
        shipment_line_count: 1,
        shipped_quantity: 4,
        has_bol_document: false,
        billing_date_mismatch_count: 0,
        ...overrides
    };
}

test("high-confidence parcel tracking is recognized without guessing freight references", () => {
    assert.deepEqual(classifyParcelTrackingReference("1ZV56D262022637037", ""), {
        isParcel: true,
        carrier: "UPS",
        reference: "1ZV56D262022637037"
    });
    assert.equal(classifyParcelTrackingReference("P062563", "CimTran").isParcel, false);
    assert.equal(classifyParcelTrackingReference("44146804", "ILC Logistics").isParcel, false);
});

test("shipment save is blocked when parcel tracking is classified as freight", () => {
    const conflict = getShipmentMethodTrackingConflict({
        shipmentMethod: "LTL_FREIGHT",
        carrierName: "UPS",
        trackingReference: "1ZV56D262022637037"
    });
    assert.equal(conflict.code, "PARCEL_TRACKING_METHOD_MISMATCH");
    assert.match(conflict.message, /Change Shipment Type to Parcel/i);
    assert.throws(() => assertShipmentMethodMatchesTrackingReference({
        shipmentMethod: "LTL_FREIGHT",
        carrierName: "Canpar",
        trackingReference: "D420352470002441739001"
    }), /Shipment Type to Parcel/i);
    assert.doesNotThrow(() => assertShipmentMethodMatchesTrackingReference({
        shipmentMethod: "PARCEL",
        carrierName: "Canpar",
        trackingReference: "D420352470002441739001"
    }));
});

test("nightly audit finds freight billing gaps and parcel classification errors", () => {
    const findings = buildShipmentDataQualityFindingCandidates([
        shipment({
            shipment_method: "LTL_FREIGHT",
            carrier_name: "UPS",
            tracking_reference: "1ZV56D262022637037",
            total_pallets: 0,
            has_bol_document: false,
            billing_date_mismatch_count: 2
        })
    ]);
    const rules = new Set(findings.map((finding) => finding.ruleCode));
    assert.equal(rules.has("PARCEL_TRACKING_METHOD_MISMATCH"), true);
    assert.equal(rules.has("FREIGHT_BOL_MISSING"), true);
    assert.equal(rules.has("FREIGHT_PALLET_COUNT_MISSING"), true);
    assert.equal(rules.has("BILLING_SERVICE_DATE_MISMATCH"), true);
});

test("clean parcel shipment does not create a data-quality finding", () => {
    assert.deepEqual(buildShipmentDataQualityFindingCandidates([shipment()]), []);
});

test("warehouse grouping cannot mix findings or notify unassigned records", () => {
    const groups = groupShipmentDataQualityFindingsByWarehouse([
        { id: "1", fulfillmentLocationId: "10", entityRef: "ORD-A" },
        { id: "2", fulfillmentLocationId: "20", entityRef: "ORD-B" },
        { id: "3", fulfillmentLocationId: "", entityRef: "ORD-UNASSIGNED" }
    ]);
    assert.deepEqual([...groups.keys()], ["10", "20"]);
    assert.deepEqual(groups.get("10").map((finding) => finding.entityRef), ["ORD-A"]);
    assert.deepEqual(groups.get("20").map((finding) => finding.entityRef), ["ORD-B"]);
});

test("warehouse notice is corrective and explicitly excludes customers", () => {
    const text = buildShipmentDataQualityWarehouseEmailText(
        { code: "TEST-WH-A", name: "Test Warehouse A" },
        [{ severity: "HIGH", entityRef: "ORD-A", accountName: "TEST COMPANY", summary: "Missing BOL", suggestedAction: "Attach the signed BOL." }],
        "2026-09-01"
    );
    assert.match(text, /orders assigned to your warehouse/i);
    assert.match(text, /Customer contacts were not included/i);
    assert.match(text, /Attach the signed BOL/i);
});

test("warehouse exception email uses service recipient plus BCC only", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const sendFunction = source.slice(
        source.indexOf("async function notifyWarehousesOfShipmentDataQualityFindings"),
        source.indexOf("async function runShipmentDataQualityAudit")
    );
    const resolver = source.slice(
        source.indexOf("async function getShipmentDataQualityWarehouseRecipients"),
        source.indexOf("function buildShipmentDataQualityWarehouseEmailText")
    );
    assert.match(sendFunction, /to:\s*visibleRecipient/);
    assert.match(sendFunction, /bcc:\s*bccRecipients\.join/);
    assert.doesNotMatch(sendFunction, /\bcc:/);
    assert.match(sendFunction, /findings\.length\s*-\s*notifiedFindings/);
    assert.doesNotMatch(resolver, /portal_vendor_access|owner_accounts|portal_login_email|billing_email/i);
    assert.match(resolver, /app_user_fulfillment_location_access/);
});

test("nightly audit becomes due at 3:00 AM Eastern", () => {
    assert.equal(isShipmentDataQualityAuditDue(new Date("2026-09-01T06:59:00Z")), false);
    assert.equal(isShipmentDataQualityAuditDue(new Date("2026-09-01T07:00:00Z")), true);
});
