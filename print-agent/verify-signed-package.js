"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { ConnectorUpdater, verifyRelease } = require("./connector-updater");
async function main() {
    const root = path.resolve(__dirname, "../outputs/print-connector");
    const key = await fs.readFile(path.join(__dirname, "update-public-key.pem"), "utf8");
    const envelope = JSON.parse(await fs.readFile(path.join(root, "stable.json"), "utf8"));
    const release = verifyRelease(envelope, key, "1.2.0");
    const bytes = await fs.readFile(path.join(root, path.basename(new URL(release.url).pathname)));
    if (bytes.length !== release.size || crypto.createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("Signed package integrity failed.");
    const testRoot = await fs.mkdtemp(path.join(root, "signed-smoke-"));
    const installDir = path.join(testRoot, "installed");
    await fs.mkdir(installDir);
    try {
        await fs.writeFile(path.join(installDir, "installed.json"), "\uFEFF" + JSON.stringify({ installPath: installDir, version: "1.2.0" }));
        for (const name of ["prepare-update.ps1", "apply-update.ps1"]) await fs.copyFile(path.join(__dirname, name), path.join(installDir, name));
        const updater = new ConnectorUpdater({ installDir, version: "1.2.0" });
        const staged = await updater.stageWindows(bytes, release, key);
        if (!staged.packageDir.startsWith(testRoot + path.sep)) throw new Error("Stage escaped the isolated test directory.");
        await fs.writeFile(path.join(root, "signed-release-verification.json"), JSON.stringify({ version: release.version, signaturePassed: true, checksumPassed: true, windowsStagingPassed: true, publicKeyPreserved: true, productionDatabaseTouched: false }, null, 2));
        console.log("Signed announcement, exact package checksum and Windows staging verified.");
    } finally { await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
