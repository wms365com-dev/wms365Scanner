"use strict";
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const run = promisify(execFile);
const FEED = "https://app.wms365.co/print-connector/releases/stable.json";
const MAX_PACKAGE = 150 * 1024 * 1024;

function versionParts(version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid connector release version.");
    return version.split(".").map(Number);
}
function newerVersion(next, current) {
    const a = versionParts(next), b = versionParts(current);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}
function releaseUrl(value) {
    const url = new URL(value);
    if (url.origin !== "https://app.wms365.co" || url.username || url.password || !url.pathname.startsWith("/print-connector/releases/") || url.hash) throw new Error("The update download address is not trusted.");
    return url.href;
}
function verifyRelease(envelope, publicKey, currentVersion, now = Date.now()) {
    if (!envelope || typeof envelope.payload !== "string" || envelope.payload.length > 12000 || typeof envelope.signature !== "string" || envelope.signature.length > 2000) throw new Error("Invalid update announcement.");
    if (!crypto.verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.signature, "base64"))) throw new Error("Update signature verification failed. Nothing was installed.");
    const release = JSON.parse(envelope.payload);
    versionParts(release.version);
    if (release.platform !== "win32-x64" || release.channel !== "stable" || !/^[a-f0-9]{64}$/i.test(release.sha256) || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > MAX_PACKAGE) throw new Error("Invalid update package details.");
    if (!Number.isFinite(Date.parse(release.expiresAt)) || !Number.isFinite(Date.parse(release.publishedAt)) || Date.parse(release.expiresAt) <= now || Date.parse(release.publishedAt) > now + 5 * 60 * 1000) throw new Error("This update announcement has expired or has an invalid date.");
    release.url = releaseUrl(release.url);
    return { ...release, available: newerVersion(release.version, currentVersion) };
}
async function downloadLimited(response, limit) {
    if (!response.ok || !response.body) throw new Error("WMS365 updates are unavailable. The installed version will continue running.");
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > limit) throw new Error("Update download exceeded its approved size.");
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
class ConnectorUpdater {
    constructor({ installDir, dataDir, version, fetchImpl = fetch, stageImpl, launchImpl, platform = process.platform }) {
        Object.assign(this, { installDir, dataDir, version, fetchImpl, platform });
        this.stageImpl = stageImpl || this.stageWindows.bind(this);
        this.launchImpl = launchImpl || this.launchWindows.bind(this);
        this.state = { status: "NOT_CONFIGURED", currentVersion: version, availableVersion: null, lastCheckAt: null, message: "Automatic updates await the publisher signing key." };
        this.busy = false;
    }
    async loadKey() {
        try { return await fs.readFile(path.join(this.installDir, "update-public-key.pem"), "utf8"); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }
    async check() {
        const key = await this.loadKey();
        if (!key) return this.state;
        const response = await this.fetchImpl(FEED, { redirect: "error", signal: AbortSignal.timeout(20000) });
        const envelope = JSON.parse((await downloadLimited(response, 16000)).toString("utf8"));
        this.release = verifyRelease(envelope, key, this.version);
        try {
            const outcome = JSON.parse((await fs.readFile(path.join(path.dirname(this.installDir), "wms365-update-status.json"), "utf8")).replace(/^\uFEFF/, ""));
            if (outcome.status === "ROLLED_BACK_OR_CANCELLED" && outcome.version === this.release.version) throw new Error("The last update failed and the previous version was restored. Contact WMS365 support before retrying this release.");
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        Object.assign(this.state, { status: this.release.available ? "AVAILABLE" : "CURRENT", availableVersion: this.release.available ? this.release.version : null, lastCheckAt: new Date().toISOString(), message: this.release.available ? "Update ready. It will install after printing finishes." : "Your connector is up to date." });
        return this.state;
    }
    async tick(agent, isMutationBusy = () => false, exit = () => process.exit(0)) {
        if (this.busy) return;
        this.busy = true;
        let paused = false;
        try {
            await this.check();
            if (!this.release?.available || this.platform !== "win32") return;
            if (agent.processing || isMutationBusy()) { this.state.status = "WAITING_FOR_PRINTING"; return; }
            // Stop new claims before any asynchronous preparation, then recheck all local actions.
            agent.paused = true; paused = true;
            if (agent.processing || isMutationBusy()) { this.state.status = "WAITING_FOR_PRINTING"; return; }
            this.state.status = "DOWNLOADING";
            const response = await this.fetchImpl(this.release.url, { redirect: "error", signal: AbortSignal.timeout(180000) });
            const bytes = await downloadLimited(response, this.release.size);
            if (bytes.length !== this.release.size || crypto.createHash("sha256").update(bytes).digest("hex") !== this.release.sha256.toLowerCase()) throw new Error("Update checksum verification failed. Nothing was installed.");
            const staged = await this.stageImpl(bytes, this.release, await this.loadKey());
            this.state.status = "INSTALLING";
            this.state.message = "Installing the verified update. Printing will resume after the connector restarts.";
            await this.launchImpl(staged, this.release);
            agent.stop();
            exit();
        } catch (error) {
            this.state.status = "ERROR"; this.state.message = error.message;
        } finally {
            if (paused && this.state.status !== "INSTALLING") agent.paused = false;
            this.busy = false;
        }
    }
    async stageWindows(bytes, release, key) {
        const marker = JSON.parse((await fs.readFile(path.join(this.installDir, "installed.json"), "utf8")).replace(/^\uFEFF/, ""));
        if (path.resolve(marker.installPath).toLowerCase() !== path.resolve(this.installDir).toLowerCase()) throw new Error("Update installation ownership check failed.");
        const directory = await fs.mkdtemp(path.join(path.dirname(this.installDir), ".wms365-update-"));
        const zip = path.join(directory, "release.zip");
        await fs.writeFile(zip, bytes, { flag: "wx" });
        await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(this.installDir, "prepare-update.ps1"), "-ZipPath", zip, "-StagePath", directory, "-Version", release.version], { windowsHide: true, timeout: 180000 });
        const packageDir = path.join(directory, "WMS365 Print Connector");
        if ((await fs.readFile(path.join(packageDir, "update-public-key.pem"), "utf8")) !== key) throw new Error("An update cannot silently replace the publisher signing key.");
        // The detached helper lives outside the directory being replaced.
        const helper = path.join(directory, "apply-update.ps1");
        await fs.copyFile(path.join(this.installDir, "apply-update.ps1"), helper);
        return { directory, packageDir, helper };
    }
    async launchWindows(staged, release) {
        await new Promise((resolve, reject) => {
            const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", staged.helper, "-InstallPath", this.installDir, "-PackagePath", staged.packageDir, "-OldProcessId", String(process.pid), "-Version", release.version, "-Port", process.env.WMS365_PRINT_AGENT_PORT || "8765"], { detached: true, windowsHide: true, stdio: "ignore" });
            child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
        });
    }
}
module.exports = { ConnectorUpdater, verifyRelease, newerVersion, releaseUrl, downloadLimited };
