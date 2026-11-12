"use strict";
const crypto = require("crypto");
const PROOF_WINDOW_SECONDS = 60;
const CREDENTIAL_LIFETIME_DAYS = 30;
const jose = () => import("jose");
function securityError(reason) {
    const error = new Error(`Access restricted. ${reason} Sign in again or contact WMS365 support.`);
    error.statusCode = 403;
    error.accessRestriction = { resourceType: "PRINT_CONNECTOR" };
    return error;
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("base64url"); }
function publicJwk(value) {
    if (!value || value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y) || Object.keys(value).some(key => !["kty", "crv", "x", "y"].includes(key))) throw securityError("This computer's public key is invalid.");
    return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}
async function generateIdentity() {
    const { generateKeyPair, exportJWK, exportPKCS8 } = await jose();
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    return { publicJwk: publicJwk(await exportJWK(publicKey)), privateKey, privatePem: await exportPKCS8(privateKey) };
}
async function importIdentity(privatePem) {
    const { importPKCS8, exportJWK } = await jose();
    const privateKey = await importPKCS8(privatePem, "ES256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    return { privateKey, publicJwk: publicJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
}
async function createProof({ identity, url, body, token, installationId, now = Date.now(), jti = crypto.randomUUID() }) {
    const { SignJWT } = await jose();
    const uri = new URL(url); uri.search = ""; uri.hash = "";
    return new SignJWT({ htm: "POST", htu: uri.href, body_sha256: digest(body), installation_id: installationId, ...(token ? { ath: digest(token) } : {}) })
        .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: identity.publicJwk })
        .setIssuedAt(Math.floor(now / 1000)).setJti(jti).sign(identity.privateKey);
}
function proofHeader(req) {
    const proof = req.headers?.dpop;
    if (typeof proof !== "string" || proof.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(proof)) throw securityError("A valid computer signature is required.");
    if (req.rawHeaders) {
        let count = 0;
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "dpop") count++;
        if (count !== 1) throw securityError("Only one computer signature is allowed.");
    }
    return proof;
}
async function verifyProof(req, { url, token, installationId, keyThumbprint, now = Date.now() }) {
    try {
        const { decodeProtectedHeader, importJWK, jwtVerify, calculateJwkThumbprint } = await jose();
        const proof = proofHeader(req);
        const header = decodeProtectedHeader(proof);
        if (header.alg !== "ES256" || header.typ !== "dpop+jwt" || header.jku || header.x5u || header.crit) throw securityError("This computer signature type is not allowed.");
        const key = publicJwk(header.jwk);
        const thumbprint = await calculateJwkThumbprint(key, "sha256");
        if (keyThumbprint && thumbprint !== keyThumbprint) throw securityError("This credential belongs to a different computer.");
        const { payload } = await jwtVerify(proof, await importJWK(key, "ES256"), { algorithms: ["ES256"], typ: "dpop+jwt", currentDate: new Date(now) });
        if (req.method !== "POST" || payload.htm !== req.method || payload.htu !== url || !Number.isInteger(payload.iat) || Math.abs(Math.floor(now / 1000) - payload.iat) > PROOF_WINDOW_SECONDS || typeof payload.jti !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.jti)) throw securityError("This computer signature has expired or does not match the request.");
        if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > 65536 || payload.body_sha256 !== digest(req.rawBody) || payload.installation_id !== installationId || (token && payload.ath !== digest(token)) || (!token && payload.ath !== undefined)) throw securityError("This request was changed or belongs to another connection.");
        return { thumbprint, publicJwk: key, jti: payload.jti, iat: payload.iat };
    } catch (error) {
        if (error.statusCode === 403) throw error;
        throw securityError("The computer signature could not be verified.");
    }
}
async function consumeProof(client, proof) {
    // PostgreSQL uniqueness makes replay protection effective across server instances.
    const result = await client.query(`insert into warehouse_print_proof_receipts (key_thumbprint, proof_id, expires_at)
        values ($1,$2,to_timestamp($3)) on conflict (key_thumbprint, proof_id) do nothing returning proof_id`,
    [proof.thumbprint, proof.jti, proof.iat + 2 * PROOF_WINDOW_SECONDS + 1]);
    if (result.rowCount !== 1) throw securityError("This computer request has already been used.");
    await client.query("delete from warehouse_print_proof_receipts where ctid in (select ctid from warehouse_print_proof_receipts where expires_at < now() limit 500)");
}
module.exports = { PROOF_WINDOW_SECONDS, CREDENTIAL_LIFETIME_DAYS, securityError, publicJwk, digest, generateIdentity, importIdentity, createProof, verifyProof, consumeProof };
if (require.main === module) {
    (async () => {
        const installationId = crypto.randomUUID();
        const rawBody = Buffer.from("{}");
        const url = "https://app.wms365.co/api/print-agent/heartbeat";
        const proof = await createProof({ identity: await generateIdentity(), url, body: rawBody, installationId });
        await verifyProof({ method: "POST", headers: { dpop: proof }, rawBody }, { url, installationId });
    })().catch(() => { console.error("Connector cryptography self-test failed."); process.exitCode = 1; });
}
