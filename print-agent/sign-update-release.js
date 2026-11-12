"use strict";
// The private signing key must be supplied from owner-controlled storage, never this repository.
const fs = require("fs");
const crypto = require("crypto");
const { releaseUrl } = require("./connector-updater");
const { unprotectSecretWindows } = require("./wms365-print-agent-core");
const [zip, version, url, privateKeyPath, output] = process.argv.slice(2);
if (!zip || !/^\d+\.\d+\.\d+$/.test(version) || !privateKeyPath || !output) throw new Error("Usage: node sign-update-release.js ZIP VERSION HTTPS_URL PRIVATE_KEY_FILE OUTPUT_JSON");
async function main() {
const bytes = fs.readFileSync(zip);
const storedKey = fs.readFileSync(privateKeyPath, "utf8");
const keyText = storedKey.trim().startsWith("{") ? await unprotectSecretWindows(JSON.parse(storedKey).protectedPrivateKey) : storedKey;
const privateKey = crypto.createPrivateKey(keyText);
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Use an Ed25519 publisher signing key.");
const payload = JSON.stringify({ version, platform: "win32-x64", channel: "stable", url: releaseUrl(url), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length, publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() });
fs.writeFileSync(output, JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, null, 2));
console.log("Signed release announcement created. Publish the package first, then stable.json.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
