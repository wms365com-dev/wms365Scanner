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

test("inbound list uses one company-scoped request without a broad empty-result fallback", () => {
    const source = section(
        "function requestPortalInboundsForCompany(company)",
        "const androidDocumentScanCallbacks"
    );
    assert.match(source, /accountName=\$\{encodeURIComponent\(company\)\}/);
    assert.match(source, /requestPortalInboundsForCompany\(company\)/);
    assert.doesNotMatch(source, /fallbackPayload|fallbackInbounds/);
    assert.doesNotMatch(source, /requestJson\("\/api\/admin\/portal-inbounds"\)/);
});

test("overlapping inbound refreshes share one request per company scope", () => {
    const source = section(
        "function requestPortalInboundsForCompany(company)",
        "function isPortalInboundsRefreshCurrent"
    );
    assert.match(source, /portalInboundsInFlight\.get\(key\)/);
    assert.match(source, /if \(existing\) return existing/);
    assert.match(source, /portalInboundsInFlight\.set\(key, request\)/);
    assert.match(source, /portalInboundsInFlight\.delete\(key\)/);
});

test("stale inbound responses cannot overwrite a company switch", () => {
    const source = section(
        "function isPortalInboundsRefreshCurrent",
        "const androidDocumentScanCallbacks"
    );
    assert.match(source, /refreshSerial === portalInboundsRefreshSerial/);
    assert.match(source, /norm\(getActiveCompany\(\)\) === companyKey/);
    assert.match(source, /if \(!isPortalInboundsRefreshCurrent\(refreshSerial, companyKey\)\) return portalInboundRecords/);
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
    assert.doesNotMatch(source, /accountName.*setHeader|requestedAccount.*setHeader/);
});
