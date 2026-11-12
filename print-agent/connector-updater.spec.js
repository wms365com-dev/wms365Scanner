"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ConnectorUpdater, verifyRelease, newerVersion, releaseUrl } = require("./connector-updater");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const bytes = Buffer.from("isolated-test-package");
const details = { version: "1.4.0", platform: "win32-x64", channel: "stable", url: "https://app.wms365.co/print-connector/releases/1.4.0.zip", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length, publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
function signed(overrides = {}) { const payload = JSON.stringify({ ...details, ...overrides }); return { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }; }
test("signed releases reject tampering, wrong keys, expiry and untrusted downloads", () => {
    assert.equal(verifyRelease(signed(), publicKey, "1.3.0").available, true);
    assert.throws(() => verifyRelease({ ...signed(), payload: signed().payload.replace("1.4.0", "9.0.0") }, publicKey, "1.3.0"), /signature/);
    assert.throws(() => verifyRelease(signed(), crypto.generateKeyPairSync("ed25519").publicKey, "1.3.0"), /signature/);
    for (const overrides of [{ expiresAt: "2020-01-01" }, { publishedAt: "bad" }, { url: "https://evil.example/file.zip" }, { size: 200000000 }, { platform: "darwin" }]) assert.throws(() => verifyRelease(signed(overrides), publicKey, "1.3.0"));
});
test("release versions cannot cause downgrades or execute commands", () => {
    assert.equal(newerVersion("1.10.0", "1.9.0"), true);
    assert.equal(newerVersion("1.2.0", "1.3.0"), false);
    assert.equal(newerVersion("1.3.0", "1.3.0"), false);
    assert.throws(() => newerVersion("1.4.0;bad", "1.3.0"));
    for (const url of ["http://app.wms365.co/print-connector/releases/a", "https://user@app.wms365.co/print-connector/releases/a", "https://app.wms365.co/other/a", "https://app.wms365.co/print-connector/releases/../private"]) assert.throws(() => releaseUrl(url));
});
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wms-ota-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const installDir = path.join(root, "installed"); await fs.mkdir(installDir);
    await fs.writeFile(path.join(installDir, "update-public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
    let staged = 0, launched = 0, exits = 0;
    const updater = new ConnectorUpdater({ installDir, version: "1.3.0", platform: "win32", fetchImpl: async url => url.endsWith("stable.json") ? Response.json(signed()) : new Response(bytes), stageImpl: async () => { staged++; return {}; }, launchImpl: async () => { launched++; }, ...options });
    const agent = { processing: false, paused: false, stopped: false, stop() { this.stopped = true; } };
    return { root, installDir, updater, agent, exit: () => { exits++; }, counts: () => ({ staged, launched, exits }) };
}
test("an update waits for an active print or local action", async t => {
    const f = await fixture(t); f.agent.processing = true;
    await f.updater.tick(f.agent, () => false, f.exit);
    assert.equal(f.updater.state.status, "WAITING_FOR_PRINTING");
    assert.equal(f.agent.paused, false); assert.equal(f.counts().staged, 0);
    f.agent.processing = false;
    await f.updater.tick(f.agent, () => true, f.exit);
    assert.equal(f.counts().staged, 0);
});
test("verified downloads pause claims, install once and stop the old connector", async t => {
    const f = await fixture(t);
    await f.updater.tick(f.agent, () => false, f.exit);
    assert.deepEqual(f.counts(), { staged: 1, launched: 1, exits: 1 });
    assert.equal(f.agent.stopped, true); assert.equal(f.agent.paused, true);
});
test("a corrupt package leaves the installed version and printing running", async t => {
    const f = await fixture(t, { fetchImpl: async url => url.endsWith("stable.json") ? Response.json(signed()) : new Response(Buffer.alloc(bytes.length)) });
    await f.updater.tick(f.agent, () => false, f.exit);
    assert.equal(f.updater.state.status, "ERROR"); assert.match(f.updater.state.message, /checksum/);
    assert.equal(f.agent.paused, false); assert.equal(f.agent.stopped, false); assert.equal(f.counts().staged, 0);
});
test("missing signing key and network failure never change an installation", async t => {
    const f = await fixture(t); await fs.unlink(path.join(f.installDir, "update-public-key.pem"));
    await f.updater.tick(f.agent, () => false, f.exit);
    assert.equal(f.updater.state.status, "NOT_CONFIGURED"); assert.equal(f.counts().staged, 0);
    await fs.writeFile(path.join(f.installDir, "update-public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
    f.updater.fetchImpl = async () => { throw new Error("Offline"); };
    await f.updater.tick(f.agent, () => false, f.exit);
    assert.equal(f.updater.state.status, "ERROR"); assert.equal(f.agent.paused, false);
});
test("failed release is not repeatedly installed after rollback", async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, "wms365-update-status.json"), JSON.stringify({ status: "ROLLED_BACK_OR_CANCELLED", version: "1.4.0" }));
    await f.updater.tick(f.agent, () => false, f.exit);
    assert.match(f.updater.state.message, /previous version/); assert.equal(f.counts().staged, 0);
});
test("a second update action cannot run during the first download", async t => {
    let unblock;
    const wait = new Promise(resolve => { unblock = resolve; });
    const f = await fixture(t, { fetchImpl: async url => { if (url.endsWith("stable.json")) { await wait; return Response.json(signed()); } return new Response(bytes); } });
    const first = f.updater.tick(f.agent, () => false, f.exit);
    await f.updater.tick(f.agent, () => false, f.exit);
    unblock(); await first;
    assert.equal(f.counts().launched, 1);
});
