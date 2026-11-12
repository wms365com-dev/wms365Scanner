const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    getUniqueParcelPackageReferences,
    extractCanparPackageBarcodes,
    verifyParcelPackageCount,
    buildShipmentDataQualityFindingCandidates
} = require("./server");

test("recorded parcel package identifiers are normalized and deduplicated", () => {
    assert.deepEqual(getUniqueParcelPackageReferences([
        "1ZV56D262022637037",
        "1zv56d262022637037",
        "1ZV56D262031080719"
    ].join(", ")), ["1ZV56D262022637037", "1ZV56D262031080719"]);
});

test("UPS and Purolator use one package per distinct carrier package identifier", async () => {
    const ups = await verifyParcelPackageCount({
        carrier_name: "UPS",
        tracking_reference: "1ZV56D262022637037, 1ZV56D262031080719"
    });
    assert.equal(ups.status, "VERIFIED");
    assert.equal(ups.packageCount, 2);
    assert.equal(ups.source, "CARRIER_PACKAGE_IDENTIFIERS");

    const purolator = await verifyParcelPackageCount({
        carrier_name: "Purolator",
        tracking_reference: "520593417733\n520593417741"
    });
    assert.equal(purolator.status, "VERIFIED");
    assert.equal(purolator.packageCount, 2);
});

test("Canpar package response is reduced to unique package barcodes without retaining the carrier payload", async () => {
    const lead = "D420352470002442488001";
    const child = "D420352470002442488002";
    const result = await verifyParcelPackageCount({ carrier_name: "Canpar", tracking_reference: lead }, {
        now: new Date("2026-09-07T12:00:00Z"),
        fetchImpl: async (_url, options) => {
            assert.deepEqual(JSON.parse(options.body), { barcode: lead, track_shipment: true });
            return {
                ok: true,
                status: 200,
                json: async () => ({ shipment: { packages: [{ barcode: lead }, { barcode: child }, { barcode: child }] } })
            };
        }
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.packageCount, 2);
    assert.equal(result.source, "CANPAR_TRACKING");
    assert.deepEqual(result.evidence.carrierPackageIdentifiers, [lead, child]);
    assert.equal(Object.prototype.hasOwnProperty.call(result.evidence, "carrierPayload"), false);
});

test("temporary carrier failures retry while malformed references require review", async () => {
    const retry = await verifyParcelPackageCount({ carrier_name: "Canpar", tracking_reference: "D420352470002442488001" }, {
        fetchImpl: async () => ({ ok: false, status: 503 })
    });
    assert.equal(retry.status, "RETRY");

    const review = await verifyParcelPackageCount({ carrier_name: "UPS", tracking_reference: "NOT-A-UPS-TRACKING-NUMBER" });
    assert.equal(review.status, "REVIEW_REQUIRED");
    assert.match(review.error, /invalid format/i);
});

test("nightly data quality flags package verification review for the assigned warehouse", () => {
    const findings = buildShipmentDataQualityFindingCandidates([{
        order_id: 1,
        order_code: "TEST-ORDER-1",
        account_name: "TEST COMPANY",
        shipment_id: 2,
        shipment_code: "TEST-SHIPMENT-2",
        fulfillment_location_id: 3,
        warehouse_code: "TEST-WH",
        shipment_method: "PARCEL",
        carrier_name: "UPS",
        tracking_reference: "1ZV56D262022637037",
        total_pallets: 0,
        confirmed_ship_date: "2026-09-07",
        shipment_line_count: 1,
        shipped_quantity: 1,
        package_count_status: "REVIEW_REQUIRED",
        package_count_attempts: 5,
        package_count_last_error: "Carrier response could not be verified."
    }]);
    const finding = findings.find((entry) => entry.ruleCode === "PARCEL_PACKAGE_COUNT_REVIEW");
    assert.ok(finding);
    assert.equal(finding.fulfillmentLocationId, 3);
    assert.equal(finding.accountName, "TEST COMPANY");
});

test("shipment completion queues verification and billing uses a shipment-scoped idempotency key", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const statusFlow = source.slice(
        source.indexOf("async function updateAdminPortalOrderStatus"),
        source.indexOf("function mobileValidationError")
    );
    const completion = source.slice(
        source.indexOf("async function completeShipmentPackageVerification"),
        source.indexOf("async function runShipmentPackageVerificationWorker")
    );
    assert.match(statusFlow, /queueShipmentPackageVerificationForShipments\(client, shipments\)/);
    assert.match(completion, /SHIPMENT:\$\{shipmentId\}:PARCEL_BOX_SUPPLY/);
    assert.match(completion, /current\.package_count_reference_hash !== shipment\.package_count_reference_hash/);
    assert.doesNotMatch(completion, /ship_to|postal|address/i);
});

test("background worker claims jobs with row locking and starts only after database initialization", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const claim = source.slice(
        source.indexOf("async function claimShipmentPackageVerifications"),
        source.indexOf("async function completeShipmentPackageVerification")
    );
    assert.match(claim, /for update skip locked/i);
    assert.match(claim, /shipment_method = 'PARCEL'/);
    assert.match(source, /databaseReady = true;[\s\S]*ensureShipmentPackageVerificationWorkerStarted\(\)/);
});

test("Canpar barcode extraction ignores unrelated numbers", () => {
    assert.deepEqual(extractCanparPackageBarcodes({ note: "Order 123", items: ["D420352470002442488001"] }), ["D420352470002442488001"]);
});
