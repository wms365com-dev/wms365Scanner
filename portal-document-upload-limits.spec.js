const assert = require("node:assert/strict");
const test = require("node:test");
const {
    MAX_PORTAL_DOCUMENT_BYTES,
    MAX_PORTAL_DOCUMENTS,
    MAX_PORTAL_DOCUMENT_REQUEST_BYTES,
    exceedsPortalDocumentLimit,
    isPortalDocumentJsonRequest
} = require("./portal-document-upload-limits");

test("portal documents allow 10 MiB each and five encoded files per request", () => {
    assert.equal(MAX_PORTAL_DOCUMENT_BYTES, 10 * 1024 * 1024);
    assert.equal(MAX_PORTAL_DOCUMENTS, 5);
    assert.ok(MAX_PORTAL_DOCUMENT_REQUEST_BYTES > Math.ceil(MAX_PORTAL_DOCUMENT_BYTES * 5 * 4 / 3));
    assert.equal(exceedsPortalDocumentLimit(MAX_PORTAL_DOCUMENT_BYTES), false);
    assert.equal(exceedsPortalDocumentLimit(MAX_PORTAL_DOCUMENT_BYTES + 1), true);
});

test("large JSON bodies are limited to portal document-bearing routes", () => {
    for (const root of ["/api/portal/orders", "/api/portal/inbounds", "/api/admin/portal-orders", "/api/admin/portal-inbounds"]) {
        assert.equal(isPortalDocumentJsonRequest("POST", root), true);
        assert.equal(isPortalDocumentJsonRequest("PUT", `${root}/123`), true);
        assert.equal(isPortalDocumentJsonRequest("POST", `${root}/123/documents`), true);
        assert.equal(isPortalDocumentJsonRequest("POST", `${root}/123/status`), true);
        assert.equal(isPortalDocumentJsonRequest("GET", root), false);
        assert.equal(isPortalDocumentJsonRequest("POST", `${root}/123/print-jobs`), false);
    }
    assert.equal(isPortalDocumentJsonRequest("POST", "/api/portal/orders/abc/documents"), false);
    assert.equal(isPortalDocumentJsonRequest("POST", "/api/admin/users"), false);
    assert.equal(isPortalDocumentJsonRequest("POST", "/api/print-agent/jobs"), false);
});
