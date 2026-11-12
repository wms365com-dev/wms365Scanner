"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { protectSecretWindows, unprotectSecretWindows } = require("./wms365-print-agent-core");
async function main() {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) throw new Error("Provision the publisher key on the owner's Windows workstation.");
    const directory = path.join(process.env.LOCALAPPDATA, "WMS365 Release Signing");
    const keyFile = path.join(directory, "publisher-key.dpapi.json");
    await fs.mkdir(directory, { recursive: true });
    let privateKey;
    try {
        const saved = JSON.parse(await fs.readFile(keyFile, "utf8"));
        privateKey = crypto.createPrivateKey(await unprotectSecretWindows(saved.protectedPrivateKey));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        privateKey = crypto.generateKeyPairSync("ed25519").privateKey;
        const protectedPrivateKey = await protectSecretWindows(privateKey.export({ type: "pkcs8", format: "pem" }));
        await fs.writeFile(keyFile, JSON.stringify({ format: "windows-dpapi-current-user", protectedPrivateKey }, null, 2), { flag: "wx" });
    }
    const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
    const publicFile = path.join(__dirname, "update-public-key.pem");
    try {
        const existing = await fs.readFile(publicFile, "utf8");
        if (existing !== publicKey) throw new Error("A different publisher key is already pinned. Key rotation requires explicit approval.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.writeFile(publicFile, publicKey);
    console.log("Publisher public key prepared. Private key is Windows-encrypted outside the project:");
    console.log(keyFile);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
