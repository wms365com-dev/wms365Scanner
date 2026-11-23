const MAX_PORTAL_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_PORTAL_DOCUMENTS = 5;
const MAX_PORTAL_DOCUMENT_REQUEST_BYTES = Math.ceil(MAX_PORTAL_DOCUMENT_BYTES * MAX_PORTAL_DOCUMENTS * 4 / 3) + 1024 * 1024;

function exceedsPortalDocumentLimit(byteCount) {
    return byteCount > MAX_PORTAL_DOCUMENT_BYTES;
}

function isPortalDocumentJsonRequest(method, pathName) {
    if (method !== "POST" && method !== "PUT") return false;
    const path = String(pathName || "").split("?")[0];
    const root = "(?:admin/portal-(?:orders|inbounds)|portal/(?:orders|inbounds))";
    if (new RegExp(`^/api/${root}$`).test(path)) return method === "POST";
    if (new RegExp(`^/api/${root}/\\d+$`).test(path)) return method === "PUT";
    return method === "POST" && new RegExp(`^/api/${root}/\\d+/(?:documents|status)$`).test(path);
}

module.exports = {
    MAX_PORTAL_DOCUMENT_BYTES,
    MAX_PORTAL_DOCUMENTS,
    MAX_PORTAL_DOCUMENT_REQUEST_BYTES,
    exceedsPortalDocumentLimit,
    isPortalDocumentJsonRequest
};
