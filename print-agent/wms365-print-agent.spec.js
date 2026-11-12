"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    AGENT_VERSION,
    PrintedReceiptStore,
    Wms365PrintAgent,
    isLabelPrintJob,
    resolveJobPrinterName,
    safeFileName,
    sanitizeAppUrl
} = require("./wms365-print-agent-core");
const { ConnectorSignIn, DOCUMENT_TYPES, sanitizePrinterMappings, saveAgentConfiguration, loadAgentConfiguration } = require("./wms365-print-agent-core");
const { isTrustedLocalRequest } = require("./wms365-print-agent");

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "wms365-print-agent-test-"));
}

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(payload); }
    };
}

test("agent version supports durable print receipts", () => {
    assert.equal(AGENT_VERSION, require("./package.json").version);
});

test("document and label jobs route to their selected local printers", () => {
    const config = {
        documentPrinterName: "WAREHOUSE LETTER",
        labelPrinterName: "WAREHOUSE LABEL"
    };
    assert.equal(isLabelPrintJob({ documentType: "UCC128_LABELS" }), true);
    assert.equal(isLabelPrintJob({ documentType: "SHIPPING_LABEL" }), true);
    assert.equal(isLabelPrintJob({ documentType: "PICK_TICKET" }), false);
    assert.equal(resolveJobPrinterName({ documentType: "PACKING_SLIP", printerName: "SERVER PRINTER" }, config), "WAREHOUSE LETTER");
    assert.equal(resolveJobPrinterName({ documentType: "PALLET_LABEL", printerName: "SERVER PRINTER" }, config), "WAREHOUSE LABEL");
    assert.equal(resolveJobPrinterName({ documentType: "SHIPPING_LABEL", printerName: "LETTER PRINTER" }, { documentPrinterName: "LETTER PRINTER" }), "");
    assert.equal(resolveJobPrinterName({ documentType: "PICK_TICKET", printerName: "SERVER PRINTER" }, {}), "SERVER PRINTER");
});

test("WMS URL requires HTTPS except for a local test server", () => {
    assert.equal(sanitizeAppUrl("https://app.wms365.co/"), "https://app.wms365.co");
    assert.equal(sanitizeAppUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
    assert.throws(() => sanitizeAppUrl("http://example.com"), /must use HTTPS/);
});

test("print job file names cannot escape the temporary directory", () => {
    assert.equal(safeFileName("../ORD:001?.pdf"), ".._ORD_001_.pdf");
    assert.doesNotMatch(safeFileName("pick/../../ticket.pdf"), /[\\/:?*]/);
});

test("printed receipts persist and match the exact payload", () => {
    const dataDir = temporaryDirectory();
    const receiptPath = path.join(dataDir, "printed-jobs.json");
    const first = new PrintedReceiptStore(receiptPath);
    first.record(42, "hash-one");
    const second = new PrintedReceiptStore(receiptPath);
    assert.equal(second.has(42, "hash-one"), true);
    assert.equal(second.has(42, "hash-two"), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a reclaimed job is acknowledged without printing twice", async () => {
    const dataDir = temporaryDirectory();
    const calls = [];
    let printCount = 0;
    const agent = new Wms365PrintAgent({
        appUrl: "http://127.0.0.1:8787",
        stationToken: "wms365ps_test",
        pollMs: 2000,
        heartbeatMs: 15000,
        dataDir
    }, {
        hostname: "TEST-PC",
        printFileImpl: async () => { printCount += 1; },
        fetchImpl: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            return jsonResponse({});
        }
    });
    const job = {
        id: 91,
        payloadType: "PDF",
        payloadBase64: Buffer.from("%PDF-1.4\nTest").toString("base64"),
        fileName: "pick-ticket.pdf",
        printerName: "TEST PRINTER"
    };

    const first = await agent.processJob(job);
    const second = await agent.processJob(job);

    assert.equal(first.recovered, false);
    assert.equal(second.recovered, true);
    assert.equal(printCount, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.recovered, true);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("invalid document payload never reaches a printer", async () => {
    const dataDir = temporaryDirectory();
    let printCount = 0;
    const agent = new Wms365PrintAgent({
        appUrl: "http://localhost:8787",
        stationToken: "wms365ps_test",
        pollMs: 2000,
        heartbeatMs: 15000,
        dataDir
    }, {
        printFileImpl: async () => { printCount += 1; },
        fetchImpl: async () => jsonResponse({})
    });

    await assert.rejects(
        agent.processJob({ id: 1, payloadType: "PDF", payloadBase64: Buffer.from("not a PDF").toString("base64") }),
        /valid PDF/
    );
    assert.equal(printCount, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("unconfigured agent does not contact WMS365", async () => {
    const dataDir = temporaryDirectory();
    let requestCount = 0;
    const agent = new Wms365PrintAgent({
        appUrl: "https://app.wms365.co",
        stationToken: "",
        pollMs: 2000,
        heartbeatMs: 15000,
        dataDir
    }, {
        fetchImpl: async () => { requestCount += 1; return jsonResponse({}); }
    });
    assert.deepEqual(await agent.pollOnce(), { processed: false, setupRequired: true });
    assert.equal(requestCount, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("each document can override the default printer", () => {
    const mappings = sanitizePrinterMappings({ BILL_OF_LADING: "BOL PRINTER", SHIPPING_LABEL: "THERMAL", UNKNOWN: "ignored" });
    assert.equal(resolveJobPrinterName({ documentType: "BILL_OF_LADING" }, { documentPrinterName: "LETTER", printerMappings: mappings }), "BOL PRINTER");
    assert.equal(resolveJobPrinterName({ documentType: "SHIPPING_LABEL" }, { labelPrinterName: "LABEL", printerMappings: mappings }), "THERMAL");
    assert.equal(Object.keys(mappings).length, Object.keys(DOCUMENT_TYPES).length);
    assert.equal(mappings.UNKNOWN, undefined);
});

test("credentials cannot be sent to another host or a redirect", async () => {
    assert.throws(() => sanitizeAppUrl("https://evil.example"), /official/);
    assert.throws(() => sanitizeAppUrl("https://user:secret@app.wms365.co"), /official/);
    assert.equal(sanitizeAppUrl("https://app.wms365.co/some/path?x=1"), "https://app.wms365.co");
    const connector = new ConnectorSignIn("https://app.wms365.co", async (_url, options) => {
        assert.equal(options.redirect, "error");
        return { ...jsonResponse({}, 401), headers: { getSetCookie: () => [] } };
    });
    await assert.rejects(connector.login("test@example.com", "not-a-real-password"));
    assert.equal(connector.cookie, "");
});

test("same-login enrollment uses a temporary session and discards it", async () => {
    const calls = [];
    const connector = new ConnectorSignIn("http://127.0.0.1:8787", async (url, options) => {
        calls.push({ url, options });
        const login = url.endsWith("/login");
        return { ...jsonResponse(url.endsWith("/warehouses") ? { warehouses: [{ id: "1" }] } : { setupToken: "test-token", tokenType: "DPoP", credentialExpiresAt: new Date(Date.now() + 86400000).toISOString() }), headers: { getSetCookie: () => login ? ["wms_session=test; HttpOnly; Secure"] : [] } };
    });
    assert.equal((await connector.login("worker@test.invalid", "fake-test-password")).warehouses.length, 1);
    assert.equal(calls[1].options.headers.Cookie, "wms_session=test");
    await connector.enroll({ fulfillmentLocationId: "1" });
    assert.equal(connector.cookie, "");
    assert.ok(calls.at(-1).url.endsWith("/logout"));
    assert.equal(Object.hasOwn(connector, "password"), false);
});

test("local control rejects DNS rebinding and cross-site requests", () => {
    const request = (headers) => ({ headers: { host: "127.0.0.1:8765", ...headers } });
    assert.equal(isTrustedLocalRequest(request({})), true);
    assert.equal(isTrustedLocalRequest(request({ host: "evil.example:8765" })), false);
    assert.equal(isTrustedLocalRequest(request({ origin: "https://evil.example" })), false);
    assert.equal(isTrustedLocalRequest(request({ "sec-fetch-site": "cross-site" })), false);
});

test("an acknowledgment outage never reports a printed job as failed or prints it again", async () => {
    const dataDir = temporaryDirectory(); let prints = 0, outage = true; const bodies = [];
    const config = { appUrl: "http://localhost:8787", stationToken: "test", installationId: "stable-test", dataDir };
    const agent = new Wms365PrintAgent(config, { printFileImpl: async () => { prints++; }, fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); if (outage) throw new Error("Offline"); return jsonResponse({}); } });
    const job = { id: 5, printerName: "TEST", payloadBase64: Buffer.from("%PDF-1.4\nTest").toString("base64") };
    await assert.rejects(agent.processJob(job), /Offline/); outage = false;
    const restarted = new Wms365PrintAgent({ ...config, stationToken: "rotated-test" }, { printFileImpl: async () => { prints++; }, fetchImpl: async () => jsonResponse({}) });
    assert.equal((await restarted.processJob(job)).recovered, true);
    assert.equal(prints, 1);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].success, true);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an interrupted printer submission requires manual review, not automatic retry", async () => {
    const dataDir = temporaryDirectory(); let prints = 0; const requests = [];
    const config = { appUrl: "http://localhost:8787", stationToken: "test", dataDir };
    const dependencies = { printFileImpl: async () => { prints++; throw new Error("Printer outcome unknown"); }, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return jsonResponse({}); } };
    const job = { id: 6, printerName: "TEST", payloadBase64: Buffer.from("%PDF-1.4\nTest").toString("base64") };
    await assert.rejects(new Wms365PrintAgent(config, dependencies).processJob(job));
    await assert.rejects(new Wms365PrintAgent(config, dependencies).processJob(job), /may already/);
    assert.equal(prints, 1);
    assert.ok(requests.every((body) => body.retry === false));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("overlapping poll calls cannot claim two jobs", async () => {
    const dataDir = temporaryDirectory(); let calls = 0, release;
    const wait = new Promise((resolve) => { release = resolve; });
    const agent = new Wms365PrintAgent({ appUrl: "http://localhost:8787", stationToken: "test", dataDir }, { fetchImpl: async () => { calls++; await wait; return jsonResponse({}); } });
    const first = agent.pollOnce();
    assert.deepEqual(await agent.pollOnce(), { processed: false, busy: true });
    release(); await first; assert.equal(calls, 1);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("next poll retries a pending acknowledgment before claiming another document", async () => {
    const dataDir = temporaryDirectory(); let outage = true, prints = 0; const requests = [];
    const agent = new Wms365PrintAgent({ appUrl: "http://localhost:8787", stationToken: "test", dataDir }, {
        printFileImpl: async () => { prints++; }, fetchImpl: async (url) => { requests.push(url); if (outage) throw new Error("Offline"); return jsonResponse({}); }
    });
    await assert.rejects(agent.processJob({ id: 12, printerName: "TEST", payloadBase64: Buffer.from("%PDF-1.4\nTest").toString("base64") }));
    outage = false; await agent.pollOnce();
    assert.ok(requests[1].endsWith("/12/complete"));
    assert.ok(requests[2].endsWith("/jobs/claim"));
    assert.equal(prints, 1);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Windows protects credentials and preserves printer choices across restart", { skip: process.platform !== "win32" }, async () => {
    const dataDir = temporaryDirectory();
    const config = await loadAgentConfiguration({ dataDir, env: {} });
    config.printerMappings = { PICK_TICKET: "TEST LETTER" };
    await saveAgentConfiguration(config, { stationToken: "test-not-a-live-token" });
    assert.doesNotMatch(fs.readFileSync(config.configPath, "utf8"), /test-not-a-live-token/);
    const loaded = await loadAgentConfiguration({ dataDir, env: {} });
    assert.equal(loaded.stationToken, "test-not-a-live-token");
    assert.equal(loaded.printerMappings.PICK_TICKET, "TEST LETTER");
    assert.equal(loaded.installationId, config.installationId);
    await saveAgentConfiguration(loaded, { clearToken: true });
    assert.equal((await loadAgentConfiguration({ dataDir, env: {} })).stationToken, "");
    fs.rmSync(dataDir, { recursive: true, force: true });
});
