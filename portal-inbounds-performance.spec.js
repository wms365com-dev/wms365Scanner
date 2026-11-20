const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function section(startText, endText) {
    const start = html.indexOf(startText);
    const end = html.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, `Could not isolate ${startText}`);
    return html.slice(start, end);
}

test("inbound list uses one company-and-warehouse-scoped request without a broad fallback", () => {
    const source = section(
        "function requestPortalInboundsForCompany(company)",
        "const androidDocumentScanCallbacks"
    );
    assert.match(source, /params\.set\("accountName", company\)/);
    assert.match(source, /params\.set\("fulfillmentLocationId", locationId\)/);
    assert.match(source, /requestPortalInboundsForCompany\(company\)/);
    assert.doesNotMatch(source, /fallbackPayload|fallbackInbounds/);
    assert.doesNotMatch(source, /requestJson\("\/api\/admin\/portal-inbounds"\)/);
});

test("overlapping inbound refreshes share one request per company and warehouse scope", () => {
    const source = section(
        "function requestPortalInboundsForCompany(company)",
        "function isPortalInboundsRefreshCurrent"
    );
    assert.match(source, /portalInboundsInFlight\.get\(key\)/);
    assert.match(source, /if \(existing\) return existing/);
    assert.match(source, /portalInboundsInFlight\.set\(key, request\)/);
    assert.match(source, /portalInboundsInFlight\.delete\(key\)/);
    assert.match(source, /ALL_WAREHOUSES/);
});

test("stale inbound responses cannot overwrite a company or warehouse switch", () => {
    const source = section(
        "function isPortalInboundsRefreshCurrent",
        "const androidDocumentScanCallbacks"
    );
    assert.match(source, /refreshSerial === portalInboundsRefreshSerial/);
    assert.match(source, /norm\(getActiveCompany\(\)\) === companyKey/);
    assert.match(source, /getActiveWarehouseAssignment\(\)\?\.fulfillmentLocationId/);
    assert.match(source, /if \(!isPortalInboundsRefreshCurrent\(refreshSerial, companyKey, locationId\)\) return portalInboundRecords/);
    assert.match(source, /portalInboundRecords = inbounds/);
});

test("inbound list exposes private performance timing and result count without changing scope", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const source = server.slice(
        server.indexOf('app.get("/api/admin/portal-inbounds"'),
        server.indexOf('app.get("/api/admin/kitting-requests"')
    );
    assert.match(source, /process\.hrtime\.bigint\(\)/);
    assert.match(source, /Server-Timing", `portal-inbounds;dur=\$\{durationMs\.toFixed\(1\)\}`/);
    assert.match(source, /X-WMS365-Result-Count", String\(visibleInbounds\.length\)/);
    assert.match(source, /Cache-Control", "no-store"/);
    assert.match(source, /assertAppUserCompanyAccess\(pool, req\.appUser, requestedAccount\)/);
    assert.match(source, /allowedCompanies\.includes\(normalizeText\(entry\.accountName\)\)/);
    assert.match(source, /getAccessibleFulfillmentLocationIdsForAppUser\(pool, req\.appUser\)/);
    assert.match(source, /allowedLocationIds\.includes\(toPositiveInt\(entry\.fulfillmentLocationId\)\)/);
    assert.doesNotMatch(source, /accountName.*setHeader|requestedAccount.*setHeader/);
});

test("sandbox verifier exercises the authenticated inbound endpoint and both isolation boundaries", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "scripts", "verify-test-company-authenticated-task-scope.js"),
        "utf8"
    );
    assert.match(source, /\/api\/admin\/portal-inbounds\?accountName=/);
    assert.match(source, /allowedInboundId/);
    assert.match(source, /deniedWarehouseInboundId/);
    assert.match(source, /deniedCompanyInboundId/);
    assert.match(source, /inboundResponse\.serverTiming/);
    assert.match(source, /inboundResponse\.resultCount/);
    assert.match(source, /delete from portal_inbounds where reference_number like/);
});
