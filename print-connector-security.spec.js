"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { generateIdentity, createProof, verifyProof, consumeProof } = require("./print-agent/connector-security");
const { requireWarehousePrintAgent, enrollWarehousePrintConnector } = require("./server");
const { ensureDeviceIdentity } = require("./print-agent/wms365-print-agent-core");
const { loadLocalAccess, secureEquals } = require("./print-agent/wms365-print-agent");
const url = "https://app.wms365.co/api/print-agent/jobs/claim";
const installationId = crypto.randomUUID();
const token = "isolated-test-token";
const rawBody = Buffer.from('{"limit":1}');
async function request(overrides = {}) {
    const identity = await generateIdentity();
    const proof = await createProof({ identity, url, body: rawBody, token, installationId, ...overrides });
    const req = { method: "POST", path: "/api/print-agent/jobs/claim", headers: { authorization: `DPoP ${token}`, dpop: proof }, rawBody };
    const verified = await verifyProof(req, { url, token, installationId });
    return { req, identity, verified };
}
test("device proof verifies the exact destination, payload, credential and installation", async () => {
    const { req, verified } = await request();
    assert.equal(verified.publicJwk.crv, "P-256");
    for (const changes of [{ url: url.replace("claim", "77/complete") }, { token: "stolen-other-token" }, { installationId: crypto.randomUUID() }, { keyThumbprint: "different-key" }]) await assert.rejects(verifyProof(req, { url, token, installationId, ...changes }), /Access restricted/);
    await assert.rejects(verifyProof({ ...req, rawBody: Buffer.from('{"limit":99}') }, { url, token, installationId }), /changed/);
    await assert.rejects(verifyProof({ ...req, method: "GET" }, { url, token, installationId }), /does not match/);
});
test("stale/future proofs and duplicate or malformed headers fail closed", async () => {
    const { req } = await request();
    await assert.rejects(verifyProof(req, { url, token, installationId, now: Date.now() + 120000 }), /expired/);
    await assert.rejects(verifyProof(req, { url, token, installationId, now: Date.now() - 120000 }), /expired/);
    await assert.rejects(verifyProof({ ...req, rawHeaders: ["DPoP", req.headers.dpop, "dpop", req.headers.dpop] }, { url, token, installationId }), /Only one/);
    await assert.rejects(verifyProof({ ...req, headers: { dpop: "not-a-jwt" } }, { url, token, installationId }), /signature/);
});
test("private keys, algorithm confusion and forged signatures are rejected", async () => {
    const { req } = await request();
    const [header, payload, signature] = req.headers.dpop.split(".");
    const original = JSON.parse(Buffer.from(header, "base64url"));
    for (const next of [{ ...original, alg: "none" }, { ...original, alg: "HS256" }, { ...original, jwk: { ...original.jwk, d: "private-data" } }, { ...original, jku: "https://evil.example/keys" }]) {
        const dpop = [Buffer.from(JSON.stringify(next)).toString("base64url"), payload, signature].join(".");
        await assert.rejects(verifyProof({ ...req, headers: { dpop } }, { url, token, installationId }), /Access restricted/);
    }
    const forged = [header, payload, Buffer.alloc(64).toString("base64url")].join(".");
    await assert.rejects(verifyProof({ ...req, headers: { dpop: forged } }, { url, token, installationId }), /could not be verified/);
});
test("proof identifiers are consumed only once across server instances", async () => {
    const { verified } = await request(); const seen = new Set();
    const client = { query: async (sql, values) => {
        if (!sql.startsWith("insert")) return { rowCount: 0 };
        const key = `${values[0]}:${values[1]}`;
        if (seen.has(key)) return { rowCount: 0 };
        seen.add(key); return { rowCount: 1 };
    } };
    await consumeProof(client, verified);
    await assert.rejects(consumeProof(client, verified), /already been used/);
});
function stationClient(station, queries = []) {
    return { query: async (sql, parameters) => {
        queries.push({ sql, parameters });
        if (sql.includes("from warehouse_print_stations s")) return { rowCount: 1, rows: [station] };
        if (sql.includes("from app_users")) return { rowCount: 1, rows: [{ id: 40, email: "test@example.invalid", role: "super_admin", is_active: true }] };
        if (sql.startsWith("insert into warehouse_print_proof_receipts")) return { rowCount: 1, rows: [{}] };
        return { rowCount: 0, rows: [] };
    } };
}
test("server accepts only a signed user/device-bound station and rejects a copied credential", async () => {
    const { req, verified } = await request(); const queries = [];
    const station = { id: 23, app_user_id: 40, fulfillment_location_id: 7, warehouse_is_active: true, device_key_thumbprint: verified.thumbprint, installation_id: installationId, credential_expires_at: new Date(Date.now() + 86400000).toISOString() };
    const result = await requireWarehousePrintAgent(req, stationClient(station, queries));
    assert.equal(result.id, 23);
    assert.ok(queries.some(item => item.sql.includes("warehouse_print_proof_receipts")));
    await assert.rejects(requireWarehousePrintAgent({ ...req, headers: { authorization: `DPoP ${token}` } }, stationClient(station)), /signature/);
    const other = await request();
    await assert.rejects(requireWarehousePrintAgent(other.req, stationClient(station)), /different computer/);
});
test("expired credentials and inactive warehouses cannot connect", async () => {
    const { req, verified } = await request();
    const station = { id: 23, app_user_id: 40, fulfillment_location_id: 7, device_key_thumbprint: verified.thumbprint, installation_id: installationId, credential_expires_at: "2020-01-01" };
    await assert.rejects(requireWarehousePrintAgent(req, stationClient(station)), /expired/);
    await assert.rejects(requireWarehousePrintAgent(req, stationClient({ ...station, warehouse_is_active: false })), /warehouse is no longer active/);
    await assert.rejects(requireWarehousePrintAgent({ ...req, headers: { authorization: `Bearer ${token}` } }, stationClient(station)), /registered again/);
});
test("tokens in URLs or JSON are rejected before any database lookup", async () => {
    let queries = 0;
    const client = { query: async () => { queries++; return {}; } };
    await assert.rejects(requireWarehousePrintAgent({ headers: {}, query: { stationToken: token }, body: { stationToken: token } }, client), /registered print connection/);
    assert.equal(queries, 0);
});
test("an unsigned enrollment cannot create or rotate a station", async () => {
    const queries = [];
    await assert.rejects(enrollWarehousePrintConnector({ query: async sql => { queries.push(sql); return { rowCount: 1, rows: [{ id: 7 }] }; } }, { id: 40, role: "warehouse_worker", assignedFulfillmentLocations: [{ id: 7 }] }, { fulfillmentLocationId: 7, installationId }, { method: "POST", path: "/api/app/print-connector/enroll", headers: {}, rawBody: Buffer.from("{}") }), /signature/);
    assert.ok(queries.every(sql => sql.startsWith("select")));
});
test("Windows identity persists encrypted and survives configuration/restarts", { skip: process.platform !== "win32" }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wms-device-security-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const first = await ensureDeviceIdentity({ dataDir, installationId });
    const second = await ensureDeviceIdentity({ dataDir, installationId });
    assert.deepEqual(first.publicJwk, second.publicJwk);
    const stored = fs.readFileSync(path.join(dataDir, "device-identity.json"), "utf8");
    assert.ok(!stored.includes("PRIVATE KEY")); assert.ok(!stored.includes('"d"'));
    await assert.rejects(ensureDeviceIdentity({ dataDir, installationId: crypto.randomUUID() }), /does not match/);
});
test("profile and cloud body limits retain existing security audit and isolation guards", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(source, /connectorBodyParser = express.json\(\{ limit: "64kb"/);
    assert.match(source, /PRINT_CONNECTOR_ALLOW_LEGACY_TOKENS", false/);
    assert.match(source, /recordAccessRestrictionAttempt\(error, req/);
});
test("local access comparisons reject malformed values without throwing", () => {
    assert.equal(secureEquals("a".repeat(64), "a".repeat(64)), true);
    assert.equal(secureEquals("a".repeat(64), "b".repeat(64)), false);
    assert.equal(secureEquals("\u00e9".repeat(64), "a".repeat(64)), false);
    assert.equal(secureEquals(undefined, undefined), false);
});
test("local dashboard access persists only as a Windows-protected secret", { skip: process.platform !== "win32" }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wms-loopback-security-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const first = await loadLocalAccess(dataDir);
    assert.equal(first, await loadLocalAccess(dataDir));
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.ok(!fs.readFileSync(path.join(dataDir, "loopback-access.json"), "utf8").includes(first));
});
test("revocation stops repeated cloud requests until reauthorization", { skip: process.platform !== "win32" }, async t => {
    const { Wms365PrintAgent } = require("./print-agent/wms365-print-agent-core");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wms-revoked-device-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let requests = 0;
    const agent = new Wms365PrintAgent({ dataDir, appUrl: "https://app.wms365.co", stationToken: token, installationId }, { fetchImpl: async () => { requests++; return Response.json({ error: "Access restricted. Device revoked." }, { status: 403 }); } });
    await assert.rejects(agent.apiRequest("/api/print-agent/jobs/claim"), /revoked/);
    await assert.rejects(agent.apiRequest("/api/print-agent/jobs/claim"), /authorization/);
    assert.equal(requests, 1); assert.equal(agent.state.status, "AUTHORIZATION_REQUIRED");
});
