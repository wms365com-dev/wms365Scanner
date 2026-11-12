"use strict";

const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateIdentity, importIdentity, createProof } = require("./connector-security");

const AGENT_VERSION = require("./package.json").version;
const DOCUMENT_TYPES = Object.freeze({ PICK_TICKET: "Pick ticket", PACKING_SLIP: "Packing slip", BILL_OF_LADING: "Bill of lading", RECEIVING_DOCUMENT: "Receiving document", SHIPPING_LABEL: "Shipping label", PALLET_LABEL: "Pallet label", LOCATION_LABEL: "Location label", UCC128_LABELS: "UCC128 / GS1 label" });
const DEFAULT_APP_URL = "https://app.wms365.co";
const DEFAULT_POLL_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 60000;
const RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFileName(value) {
    return String(value || "wms365-print-job.pdf")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) || "wms365-print-job.pdf";
}

function sanitizeAppUrl(value) {
    const candidate = String(value || DEFAULT_APP_URL).trim().replace(/\/+$/, "");
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch (_error) {
        throw new Error("Enter a valid WMS365 URL.");
    }
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
        throw new Error("The WMS365 URL must use HTTPS.");
    }
    if (parsed.username || parsed.password || (!local && parsed.origin !== DEFAULT_APP_URL)) {
        throw new Error("Use the official WMS365 address: https://app.wms365.co.");
    }
    return parsed.origin;
}

function sanitizePrinterMappings(value = {}) {
    return Object.fromEntries(Object.keys(DOCUMENT_TYPES).map((type) => [type, String(value[type] || "").trim().slice(0, 180)]));
}

class ConnectorSignIn {
    constructor(appUrl, fetchImpl = global.fetch, identityProvider = generateIdentity) {
        this.appUrl = sanitizeAppUrl(appUrl);
        this.fetch = fetchImpl;
        this.cookie = "";
        this.identityProvider = identityProvider;
    }

    async request(route, body, proof = "") {
        const bodyText = JSON.stringify(body);
        const response = await this.fetch(`${this.appUrl}${route}`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
            headers: { "Content-Type": "application/json", ...(proof ? { DPoP: proof } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
            body: bodyText
        });
        let payload;
        try { payload = JSON.parse(await response.text()); }
        catch (_error) { throw new Error("WMS365 is unavailable right now. Please try signing in again shortly."); }
        if (!response.ok) throw new Error(payload.error || payload.message || "WMS365 could not complete sign-in.");
        const cookies = response.headers?.getSetCookie?.() || [];
        if (cookies.length) this.cookie = cookies.map((item) => item.split(";")[0]).join("; ");
        return payload;
    }

    async login(email, password) {
        await this.logout();
        try {
            await this.request("/api/app/login", { email, password });
            if (!this.cookie) throw new Error("WMS365 did not return a secure sign-in session.");
            return await this.request("/api/app/print-connector/warehouses", {});
        } catch (error) {
            await this.logout();
            throw error;
        }
    }

    async enroll(body) {
        if (!this.cookie) throw new Error("Sign in to WMS365 first.");
        try {
            const identity = await this.identityProvider();
            const proof = await createProof({ identity, url: `${this.appUrl}/api/app/print-connector/enroll`, body: JSON.stringify(body), installationId: body.installationId });
            const result = await this.request("/api/app/print-connector/enroll", body, proof);
            if (result.tokenType !== "DPoP" || !Number.isFinite(Date.parse(result.credentialExpiresAt))) throw new Error("The server does not support secure device registration yet. Contact WMS365 support.");
            return result;
        }
        finally { await this.logout(); }
    }

    async logout() {
        if (this.cookie) {
            try { await this.request("/api/app/logout", {}); } catch (_error) { /* Session also expires server-side. */ }
        }
        this.cookie = "";
    }
}

function boundedNumber(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function defaultDataDirectory(env = process.env) {
    if (env.WMS365_PRINT_AGENT_DATA_DIR) return path.resolve(env.WMS365_PRINT_AGENT_DATA_DIR);
    if (process.platform === "win32") {
        return path.join(env.LOCALAPPDATA || os.homedir(), "WMS365 Print Agent Data");
    }
    return path.join(os.homedir(), ".wms365-print-agent");
}

function runCommand(command, args = [], { input = "", ...options } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
        if (input) child.stdin?.write(input);
        child.stdin?.end();
    });
}

async function protectSecretWindows(secret) {
    const script = [
        "Add-Type -AssemblyName System.Security",
        "$value=[Console]::In.ReadToEnd()",
        "$bytes=[Text.Encoding]::UTF8.GetBytes($value)",
        "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Convert]::ToBase64String($protected)"
    ].join(";");
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: secret });
    return String(stdout || "").trim();
}

async function unprotectSecretWindows(protectedValue) {
    const script = [
        "Add-Type -AssemblyName System.Security",
        "$value=[Console]::In.ReadToEnd()",
        "$bytes=[Convert]::FromBase64String($value)",
        "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Text.Encoding]::UTF8.GetString($plain)"
    ].join(";");
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: protectedValue });
    return String(stdout || "").trim();
}

async function loadAgentConfiguration({ env = process.env, dataDir = defaultDataDirectory(env) } = {}) {
    const configPath = path.join(dataDir, "config.json");
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    let stationToken = String(env.WMS365_PRINT_STATION_TOKEN || "").trim();
    if (!stationToken && stored.stationTokenProtected && process.platform === "win32") {
        stationToken = await unprotectSecretWindows(stored.stationTokenProtected);
    }
    return {
        appUrl: sanitizeAppUrl(env.WMS365_APP_URL || stored.appUrl || DEFAULT_APP_URL),
        stationToken,
        credentialExpiresAt: stored.credentialExpiresAt || null,
        pollMs: boundedNumber(env.WMS365_PRINT_POLL_MS || stored.pollMs, DEFAULT_POLL_MS, 2000, 60000),
        heartbeatMs: boundedNumber(env.WMS365_PRINT_HEARTBEAT_MS || stored.heartbeatMs, DEFAULT_HEARTBEAT_MS, 15000, 300000),
        documentPrinterName: String(env.WMS365_DOCUMENT_PRINTER || stored.documentPrinterName || "").trim(),
        labelPrinterName: String(env.WMS365_LABEL_PRINTER || stored.labelPrinterName || "").trim(),
        printerMappings: sanitizePrinterMappings(stored.printerMappings),
        installationId: stored.installationId || crypto.randomUUID(),
        printExecutable: String(env.WMS365_PRINT_EXECUTABLE || stored.printExecutable || "").trim(),
        printArguments: Array.isArray(stored.printArguments) ? stored.printArguments.map(String) : [],
        dataDir,
        configPath
    };
}

async function ensureDeviceIdentity(config) {
    if (config.deviceIdentity) return config.deviceIdentity;
    if (config.identityPromise) return config.identityPromise;
    config.identityPromise = (async () => {
        const identityPath = path.join(config.dataDir, "device-identity.json");
        try {
            const saved = JSON.parse(fs.readFileSync(identityPath, "utf8"));
            if (saved.installationId !== config.installationId) throw new Error("The secure computer identity does not match this installation. Contact WMS365 support.");
            const identity = await importIdentity(await unprotectSecretWindows(saved.privateKeyProtected));
            config.deviceIdentity = identity;
            return identity;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (process.platform !== "win32") throw new Error("This connector requires Windows-protected device identity storage.");
        const identity = await generateIdentity();
        const privateKeyProtected = await protectSecretWindows(identity.privatePem);
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(identityPath, JSON.stringify({ installationId: config.installationId, privateKeyProtected }), { flag: "wx", mode: 0o600 });
        delete identity.privatePem;
        config.deviceIdentity = identity;
        return identity;
    })();
    try { return await config.identityPromise; } finally { delete config.identityPromise; }
}

async function saveAgentConfiguration(config, { stationToken = "", clearToken = false } = {}) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const existing = fs.existsSync(config.configPath)
        ? JSON.parse(fs.readFileSync(config.configPath, "utf8"))
        : {};
    let stationTokenProtected = clearToken ? "" : (existing.stationTokenProtected || "");
    if (stationToken) {
        if (process.platform !== "win32") {
            throw new Error("Save the station token as WMS365_PRINT_STATION_TOKEN on this operating system.");
        }
        stationTokenProtected = await protectSecretWindows(stationToken);
    }
    const saved = {
        schemaVersion: 1,
        appUrl: sanitizeAppUrl(config.appUrl),
        pollMs: boundedNumber(config.pollMs, DEFAULT_POLL_MS, 2000, 60000),
        heartbeatMs: boundedNumber(config.heartbeatMs, DEFAULT_HEARTBEAT_MS, 15000, 300000),
        stationTokenProtected,
        credentialExpiresAt: clearToken ? null : config.credentialExpiresAt || existing.credentialExpiresAt || null,
        documentPrinterName: String(config.documentPrinterName || "").trim(),
        labelPrinterName: String(config.labelPrinterName || "").trim(),
        printerMappings: sanitizePrinterMappings(config.printerMappings),
        installationId: config.installationId || crypto.randomUUID(),
        printExecutable: String(config.printExecutable || "").trim(),
        printArguments: Array.isArray(config.printArguments) ? config.printArguments.map(String) : []
    };
    const temporaryPath = `${config.configPath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, config.configPath);
    return saved;
}

function isLabelPrintJob(job = {}) {
    const type = String(job.documentType || job.document_type || job.printerRole || job.printer_role || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
    return [
        "SHIPPING_LABEL",
        "PALLET_LABEL",
        "LOCATION_LABEL",
        "UCC128",
        "UCC_128",
        "UCC128_LABELS",
        "GS1_128",
        "GS1_128_LABELS"
    ].includes(type);
}

function resolveJobPrinterName(job = {}, config = {}) {
    const type = String(job.documentType || job.document_type || "").toUpperCase().replace(/[\s-]+/g, "_");
    if (config.printerMappings?.[type]) return config.printerMappings[type];
    if (isLabelPrintJob(job)) return String(config.labelPrinterName || "").trim();
    const localPrinter = config.documentPrinterName;
    return String(localPrinter || job.printerName || job.printer_name || "").trim();
}

async function listLocalPrinters() {
    if (process.platform !== "win32") return [];
    let stdout = "";
    try {
        ({ stdout } = await runCommand("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Printer | Select-Object Name,PrinterStatus,Default | ConvertTo-Json -Compress"
        ]));
    } catch (_error) {
        ({ stdout } = await runCommand("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName System.Drawing; [System.Drawing.Printing.PrinterSettings]::InstalledPrinters | ForEach-Object { [PSCustomObject]@{Name=[string]$_;PrinterStatus='';Default=$false} } | ConvertTo-Json -Compress"
        ]));
    }
    const parsed = JSON.parse(stdout || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((printer) => ({
        name: String(printer.Name || ""),
        status: String(printer.PrinterStatus || ""),
        isDefault: printer.Default === true
    })).filter((printer) => printer.name);
}

function findSumatraPdf(env = process.env) {
    if (env.WMS365_SUMATRA_PATH && fs.existsSync(env.WMS365_SUMATRA_PATH)) return env.WMS365_SUMATRA_PATH;
    if (process.platform !== "win32") return "";
    const candidates = [
        path.join(__dirname, "tools", "SumatraPDF.exe"),
        path.join(env.ProgramFiles || "C:\\Program Files", "SumatraPDF", "SumatraPDF.exe"),
        path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SumatraPDF", "SumatraPDF.exe"),
        path.join(env.LOCALAPPDATA || "", "SumatraPDF", "SumatraPDF.exe")
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function replacePrintArgument(value, filePath, printerName) {
    return String(value).replace(/\{file\}/g, filePath).replace(/\{printer\}/g, printerName || "");
}

async function printPdfFile(filePath, printerName, config = {}) {
    if (!printerName) throw new Error("Choose a printer for this document before printing.");
    if (config.printExecutable) {
        const args = (config.printArguments || []).map((arg) => replacePrintArgument(arg, filePath, printerName));
        await runCommand(config.printExecutable, args);
        return;
    }
    if (process.platform === "win32") {
        const sumatra = findSumatraPdf();
        if (sumatra) {
            const args = printerName
                ? ["-print-to", printerName, "-silent", filePath]
                : ["-print-to-default", "-silent", filePath];
            args.splice(args.length - 1, 0, "-print-settings", config.mediaType === "LABEL" ? "noscale" : "fit");
            await runCommand(sumatra, args, { timeout: 120000 });
            return;
        }
        throw new Error("The PDF print engine is missing. Reinstall WMS365 Print Agent.");
    }
    await runCommand("lp", printerName ? ["-d", printerName, filePath] : [filePath]);
}

async function printTestPage(printerName) {
    if (!printerName) throw new Error("Choose a printer first.");
    if (process.platform !== "win32") {
        const testPath = path.join(os.tmpdir(), `wms365-printer-test-${Date.now()}.txt`);
        fs.writeFileSync(testPath, `WMS365 printer test\n${new Date().toISOString()}\n`);
        try { await runCommand("lp", ["-d", printerName, testPath]); } finally { fs.rmSync(testPath, { force: true }); }
        return;
    }
    const encodedPrinter = Buffer.from(printerName, "utf8").toString("base64");
    const script = [
        `$printer=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPrinter}'))`,
        `$lines=@('WMS365 PRINTER TEST','Printer: '+$printer,'Computer: '+$env:COMPUTERNAME,'Time: '+(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))`,
        "$lines | Out-Printer -Name $printer"
    ].join(";");
    await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

class PrintedReceiptStore {
    constructor(filePath, { now = () => Date.now() } = {}) {
        this.filePath = filePath;
        this.now = now;
        this.entries = {};
        this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            this.entries = parsed.entries || {};
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            this.entries = {};
        }
        this.prune();
    }

    prune() {
        const cutoff = this.now() - RECEIPT_RETENTION_MS;
        const sorted = Object.entries(this.entries)
            .filter(([, entry]) => entry.status === "SUBMITTING" || Number(entry.printedAtMs) >= cutoff)
            .sort((a, b) => Number(b[1].printedAtMs) - Number(a[1].printedAtMs));
        this.entries = Object.fromEntries(sorted);
    }

    has(jobId, payloadHash) {
        const entry = this.entries[String(jobId)];
        return Boolean(entry && entry.payloadHash === payloadHash && entry.status !== "SUBMITTING");
    }

    isUncertain(jobId, payloadHash) {
        const entry = this.entries[String(jobId)];
        return Boolean(entry && entry.payloadHash === payloadHash && entry.status === "SUBMITTING");
    }

    record(jobId, payloadHash, status = "SPOOLED") {
        this.entries[String(jobId)] = { payloadHash, status, acknowledged: false, printedAtMs: this.now() };
        this.save();
    }

    acknowledge(jobId) {
        this.entries[String(jobId)].acknowledged = true;
        this.save();
    }

    save() {
        this.prune();
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporaryPath, this.filePath);
    }
}

class Wms365PrintAgent {
    constructor(config, dependencies = {}) {
        this.config = config;
        this.fetch = dependencies.fetchImpl || global.fetch;
        this.printFile = dependencies.printFileImpl || printPdfFile;
        this.listPrinters = dependencies.listPrintersImpl || listLocalPrinters;
        this.hostname = dependencies.hostname || os.hostname();
        this.receipts = dependencies.receiptStore || new PrintedReceiptStore(path.join(config.dataDir, "printed-jobs.json"));
        this.state = {
            connected: false,
            status: config.stationToken ? "CONNECTING" : "SETUP_REQUIRED",
            station: null,
            printers: [],
            lastHeartbeatAt: null,
            lastPollAt: null,
            lastPrintedAt: null,
            lastJobTitle: "",
            lastError: "",
            printedCount: 0,
            recoveredCount: 0
        };
        this.stopped = false;
        this.processing = false;
        this.paused = false;
    }

    publicStatus() {
        return {
            ...this.state,
            agentVersion: AGENT_VERSION,
            appUrl: this.config.appUrl,
            hasStationToken: Boolean(this.config.stationToken),
            credentialExpiresAt: this.state.credentialExpiresAt || this.config.credentialExpiresAt || null,
            hostName: this.hostname,
            pollMs: this.config.pollMs,
            heartbeatMs: this.config.heartbeatMs,
            documentPrinterName: this.config.documentPrinterName || "",
            labelPrinterName: this.config.labelPrinterName || "",
            printerMappings: this.config.printerMappings || {}
        };
    }

    async apiRequest(pathName, body = {}) {
        if (!this.config.stationToken) throw new Error("Print station setup is required.");
        if (this.authorizationBlocked && pathName !== "/api/print-agent/disconnect") throw new Error("This print connection needs authorization. Sign out, then sign in again.");
        if (!/^\/api\/print-agent\/(heartbeat|disconnect|jobs\/claim|jobs\/\d+\/complete)$/.test(pathName)) throw new Error("This print connection cannot access that address.");
        const bodyText = JSON.stringify(body);
        const proof = await createProof({ identity: await ensureDeviceIdentity(this.config), url: `${this.config.appUrl}${pathName}`, body: bodyText, token: this.config.stationToken, installationId: this.config.installationId });
        const response = await this.fetch(`${this.config.appUrl}${pathName}`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(20000),
            headers: {
                "Content-Type": "application/json",
                "Authorization": `DPoP ${this.config.stationToken}`,
                "DPoP": proof,
                "X-WMS365-Hostname": this.hostname,
                "User-Agent": `WMS365-Print-Agent/${AGENT_VERSION}`
            },
            body: bodyText
        });
        const responseText = await response.text();
        let payload = {};
        try { payload = responseText ? JSON.parse(responseText) : {}; } catch (_error) { payload = {}; }
        if (!response.ok) {
            const error = new Error(payload.error || payload.message || `WMS365 returned HTTP ${response.status}.`);
            if ([401, 403].includes(response.status)) {
                this.authorizationBlocked = true;
                this.state.connected = false;
                this.state.status = "AUTHORIZATION_REQUIRED";
                this.state.lastError = error.message;
            }
            throw error;
        }
        return payload;
    }

    async heartbeat() {
        if (!this.config.stationToken) {
            this.state.status = "SETUP_REQUIRED";
            return null;
        }
        const printers = await this.listPrinters();
        const result = await this.apiRequest("/api/print-agent/heartbeat", {
            agentVersion: AGENT_VERSION,
            hostName: this.hostname,
            localPrinters: printers,
            printerMappings: this.config.printerMappings,
            documentPrinterName: this.config.documentPrinterName,
            labelPrinterName: this.config.labelPrinterName
        });
        this.state.connected = true;
        this.state.credentialExpiresAt = result.credentialExpiresAt || this.config.credentialExpiresAt || null;
        this.state.status = "ONLINE";
        this.state.station = result.station || null;
        this.state.printers = printers;
        this.state.lastHeartbeatAt = new Date().toISOString();
        this.state.lastError = "";
        return result;
    }

    async processJob(job) {
        if (!job?.id) return { processed: false };
        if (String(job.payloadType || "PDF").toUpperCase() !== "PDF") {
            throw new Error(`Unsupported print payload type: ${job.payloadType || "unknown"}.`);
        }
        const payload = Buffer.from(job.payloadBase64 || "", "base64");
        if (!payload.length || payload.toString("ascii", 0, 4) !== "%PDF") {
            throw new Error("The print job did not contain a valid PDF.");
        }
        const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
        const receiptId = `${crypto.createHash("sha256").update(this.config.appUrl + (this.config.installationId || this.config.stationToken)).digest("hex").slice(0, 16)}:${job.id}`;
        if (this.receipts.isUncertain(receiptId, payloadHash)) {
            const error = "This job may already have reached the printer. Check the printer before requesting a new copy in WMS365.";
            await this.apiRequest(`/api/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, { success: false, retry: false, error });
            throw new Error(error);
        }
        if (this.receipts.has(receiptId, payloadHash) || this.receipts.has(job.id, payloadHash)) {
            await this.apiRequest(`/api/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, { success: true, status: "PRINTED", recovered: true });
            this.receipts.record(receiptId, payloadHash);
            this.receipts.acknowledge(receiptId);
            this.state.recoveredCount += 1;
            this.state.lastPrintedAt = new Date().toISOString();
            this.state.lastJobTitle = job.documentTitle || job.fileName || `Job ${job.id}`;
            return { processed: true, recovered: true };
        }
        const fileName = safeFileName(job.fileName || `wms365-job-${job.id}.pdf`);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wms365-print-"));
        const filePath = path.join(directory, fileName);
        let submitted = false;
        try {
            fs.writeFileSync(filePath, payload, { mode: 0o600 });
            const printerName = resolveJobPrinterName(job, this.config);
            if (!printerName) throw new Error("No printer is selected for this document.");
            this.receipts.record(receiptId, payloadHash, "SUBMITTING");
            submitted = true;
            await this.printFile(filePath, printerName, { ...this.config, mediaType: isLabelPrintJob(job) ? "LABEL" : "DOCUMENT" });
            this.receipts.record(receiptId, payloadHash);
            await this.apiRequest(`/api/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, { success: true, status: "PRINTED" });
            this.receipts.acknowledge(receiptId);
            this.state.printedCount += 1;
            this.state.lastPrintedAt = new Date().toISOString();
            this.state.lastJobTitle = job.documentTitle || fileName;
            this.state.lastError = "";
            return { processed: true, recovered: false };
        } catch (error) {
            try {
                if (this.receipts.has(receiptId, payloadHash)) throw error;
                await this.apiRequest(`/api/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, {
                    success: false,
                    retry: !submitted,
                    status: "FAILED",
                    error: String(error.stderr || error.message || "Print failed").slice(0, 1000)
                });
            } catch (_reportError) {
                // The local receipt prevents duplicate printing if completion reporting failed.
            }
            throw error;
        } finally {
            if (process.env.WMS365_KEEP_PRINT_FILES !== "1") {
                fs.rmSync(filePath, { force: true });
                fs.rmdirSync(directory);
            }
        }
    }

    async pollOnce() {
        if (!this.config.stationToken) return { processed: false, setupRequired: true };
        if (this.paused || this.stopped) return { processed: false, paused: true };
        if (this.processing) return { processed: false, busy: true };
        this.processing = true;
        try {
        const prefix = crypto.createHash("sha256").update(this.config.appUrl + (this.config.installationId || this.config.stationToken)).digest("hex").slice(0, 16) + ":";
        for (const [receiptId, entry] of Object.entries(this.receipts.entries)) {
            if (!receiptId.startsWith(prefix) || entry.status !== "SPOOLED" || entry.acknowledged) continue;
            const jobId = receiptId.slice(prefix.length);
            await this.apiRequest(`/api/print-agent/jobs/${encodeURIComponent(jobId)}/complete`, { success: true, status: "PRINTED", recovered: true });
            this.receipts.acknowledge(receiptId);
        }
        this.state.lastPollAt = new Date().toISOString();
        const result = await this.apiRequest("/api/print-agent/jobs/claim", { limit: 1 });
        if (!result.job) return { processed: false };
        return await this.processJob(result.job);
        } finally { this.processing = false; }
    }

    async runLoop() {
        this.stopped = false;
        while (!this.stopped) {
            if (!this.config.stationToken || this.authorizationBlocked) {
                if (this.authorizationBlocked) { await sleep(1000); continue; }
                this.state.status = "SETUP_REQUIRED";
                await sleep(1000);
                continue;
            }
            try {
                const heartbeatDue = !this.state.lastHeartbeatAt
                    || Date.now() - new Date(this.state.lastHeartbeatAt).getTime() >= this.config.heartbeatMs;
                if (heartbeatDue) await this.heartbeat();
                if (this.stopped) break;
                await this.pollOnce();
            } catch (error) {
                this.state.connected = false;
                this.state.status = this.authorizationBlocked ? "AUTHORIZATION_REQUIRED" : "OFFLINE";
                this.state.lastError = error.message || "Connection or printing failed.";
                await sleep(Math.min(this.config.pollMs * 3, 30000));
            }
            await sleep(this.config.pollMs);
        }
    }

    stop() {
        this.stopped = true;
    }
}

module.exports = {
    ConnectorSignIn,
    DOCUMENT_TYPES,
    sanitizePrinterMappings,
    AGENT_VERSION,
    DEFAULT_APP_URL,
    PrintedReceiptStore,
    Wms365PrintAgent,
    defaultDataDirectory,
    findSumatraPdf,
    listLocalPrinters,
    loadAgentConfiguration,
    printPdfFile,
    printTestPage,
    protectSecretWindows,
    safeFileName,
    sanitizeAppUrl,
    saveAgentConfiguration,
    ensureDeviceIdentity,
    isLabelPrintJob,
    resolveJobPrinterName,
    unprotectSecretWindows
};
