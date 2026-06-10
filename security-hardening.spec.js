const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
    app,
    RBAC_PERMISSIONS,
    roleHasPermission,
    userHasPermission,
    isKnownAiCrawlerUserAgent,
    validateProductionEnvironment,
    assertProductionEnvironment,
    isForbiddenOutboundEmailSender,
    assertOutboundEmailSenderAllowed,
    sanitizePortalOrderDocumentInput,
    detectSafeUploadMimeType,
    encryptSecret,
    decryptSecret,
    assertDestructiveImportAllowed
} = require("./server.js");

function dataUrl(mimeType, buffer) {
    return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
}

function request(server, pathName, options = {}) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const req = http.request({
            host: "127.0.0.1",
            port: address.port,
            path: pathName,
            method: "GET",
            headers: options.headers || {}
        }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("production startup validation blocks missing admin and encryption settings", () => {
    const missing = validateProductionEnvironment({ NODE_ENV: "production", DATABASE_URL: "postgres://db" });
    assert.deepEqual(missing, ["APP_ADMIN_EMAIL", "APP_ADMIN_PASSWORD", "INTEGRATION_SECRET_KEY or APP_SECRET"]);
    assert.throws(
        () => assertProductionEnvironment({ NODE_ENV: "production", DATABASE_URL: "postgres://db" }),
        /Production startup blocked/
    );
});

test("production startup validation passes with required settings", () => {
    const missing = validateProductionEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://db",
        APP_ADMIN_EMAIL: "owner@example.com",
        APP_ADMIN_PASSWORD: "long-random-password",
        INTEGRATION_SECRET_KEY: "32-byte-minimum-production-secret"
    });
    assert.deepEqual(missing, []);
});

test("system email blocks forbidden Greywolf Gmail sender", () => {
    assert.equal(isForbiddenOutboundEmailSender("greywolf3plca@gmail.com"), true);
    assert.equal(isForbiddenOutboundEmailSender("WMS365 <support@wms365.co>"), false);
    assert.throws(
        () => assertOutboundEmailSenderAllowed({ from: "Greywolf <greywolf3plca@gmail.com>" }),
        /not allowed as a WMS365 outbound sender/
    );

    const missing = validateProductionEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://db",
        APP_ADMIN_EMAIL: "owner@example.com",
        APP_ADMIN_PASSWORD: "long-random-password",
        INTEGRATION_SECRET_KEY: "32-byte-minimum-production-secret",
        SMTP_USER: "greywolf3plca@gmail.com"
    });
    assert.deepEqual(missing, ["Remove forbidden outbound email sender: SMTP_USER"]);
});

test("upload validation accepts PDF JPEG PNG and WebP signatures only", () => {
    assert.equal(detectSafeUploadMimeType(Buffer.from("%PDF-1.7\n")), "application/pdf");
    assert.equal(detectSafeUploadMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
    assert.equal(detectSafeUploadMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
    assert.equal(detectSafeUploadMimeType(Buffer.from("RIFF1234WEBP", "ascii")), "image/webp");

    const saved = sanitizePortalOrderDocumentInput({
        fileName: "label.pdf",
        fileType: "application/pdf",
        dataUrl: dataUrl("application/pdf", Buffer.from("%PDF-1.7\n"))
    });
    assert.equal(saved.fileType, "application/pdf");
    assert.equal(saved.fileName, "label.pdf");
});

test("upload validation rejects SVG and unknown MIME/content", () => {
    assert.throws(
        () => sanitizePortalOrderDocumentInput({
            fileName: "bad.svg",
            fileType: "image/svg+xml",
            dataUrl: dataUrl("image/svg+xml", Buffer.from("<svg><script>alert(1)</script></svg>"))
        }),
        /PDF, JPEG, PNG, or WebP/
    );
    assert.throws(
        () => sanitizePortalOrderDocumentInput({
            fileName: "fake.pdf",
            fileType: "application/pdf",
            dataUrl: dataUrl("application/pdf", Buffer.from("not a pdf"))
        }),
        /could not be verified/
    );
});

test("integration secrets encrypt and decrypt with AES-GCM envelope", () => {
    const secretKey = "unit-test-secret-key";
    const encrypted = encryptSecret("shpat_test_token", secretKey);
    assert.match(encrypted, /^enc:v1:/);
    assert.notEqual(encrypted, "shpat_test_token");
    assert.equal(decryptSecret(encrypted, secretKey), "shpat_test_token");
});

test("destructive import requires feature flag and typed confirmation", () => {
    assert.throws(
        () => assertDestructiveImportAllowed({ body: { confirmationToken: "IMPORT WMS365" } }, { allow: false }),
        /disabled/
    );
    assert.throws(
        () => assertDestructiveImportAllowed({ body: { confirmationToken: "wrong" } }, { allow: true }),
        /Type IMPORT WMS365/
    );
    assert.doesNotThrow(() => assertDestructiveImportAllowed({ body: { confirmationToken: "IMPORT WMS365" } }, { allow: true }));
});

test("automation permission is only granted to the WMS365 owner email", () => {
    assert.equal(roleHasPermission("super_admin", RBAC_PERMISSIONS.ALLOW_AUTOMATION), false);
    assert.equal(userHasPermission({ email: "other.owner@example.com", role: "super_admin" }, RBAC_PERMISSIONS.ALLOW_AUTOMATION), false);
    assert.equal(userHasPermission({ email: "k.prathab@gmail.com", role: "warehouse_worker" }, RBAC_PERMISSIONS.ALLOW_AUTOMATION), true);
});

test("known AI crawler user agents are detected and blocked", async () => {
    assert.equal(isKnownAiCrawlerUserAgent("Mozilla/5.0 AppleWebKit GPTBot"), true);
    assert.equal(isKnownAiCrawlerUserAgent("Mozilla/5.0 Chrome Safari"), false);

    const server = app.listen(0);
    try {
        const response = await request(server, "/", { headers: { "User-Agent": "ChatGPT-User" } });
        assert.equal(response.statusCode, 403);
        assert.match(response.body, /Automated access, scraping, AI analysis/);
        assert.equal(response.headers["x-wms365-blocked-reason"], "ai-crawler");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("llms.txt is public and carries the no-automation policy", async () => {
    const server = app.listen(0);
    try {
        const response = await request(server, "/llms.txt");
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Do not crawl or scrape WMS365/);
        assert.match(response.headers["x-robots-tag"], /noai/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("health endpoint returns 503 when database is unavailable", async () => {
    const server = app.listen(0);
    try {
        const response = await request(server, "/api/health");
        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).ok, false);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
