"use strict";

const { exec, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_URL = String(process.env.WMS365_APP_URL || "https://app.wms365.co").replace(/\/+$/, "");
const STATION_TOKEN = String(process.env.WMS365_PRINT_STATION_TOKEN || "").trim();
const POLL_MS = Math.max(2000, Number.parseInt(process.env.WMS365_PRINT_POLL_MS || "5000", 10) || 5000);
const HEARTBEAT_MS = Math.max(15000, Number.parseInt(process.env.WMS365_PRINT_HEARTBEAT_MS || "60000", 10) || 60000);
const PRINT_COMMAND = String(process.env.WMS365_PRINT_COMMAND || "").trim();
const AGENT_VERSION = "0.1.0";

if (!STATION_TOKEN) {
    console.error("WMS365_PRINT_STATION_TOKEN is required.");
    process.exit(1);
}

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

function shellQuote(value) {
    return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function psSingleQuote(value) {
    return `'${String(value || "").replace(/'/g, "''")}'`;
}

async function apiRequest(pathName, body = {}) {
    const response = await fetch(`${APP_URL}${pathName}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${STATION_TOKEN}`,
            "X-WMS365-Hostname": os.hostname(),
            "User-Agent": `WMS365-Print-Agent/${AGENT_VERSION}`
        },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch (_error) {
        payload = { raw: text };
    }
    if (!response.ok) {
        throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    }
    return payload;
}

function runCommand(command, args = [], options = {}) {
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
        child.stdin?.end?.();
    });
}

function runShell(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function listLocalPrinters() {
    if (process.platform === "win32") {
        try {
            const { stdout } = await runCommand("powershell.exe", [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Get-Printer | Select-Object Name,PrinterStatus,Default | ConvertTo-Json -Compress"
            ]);
            const parsed = JSON.parse(stdout || "[]");
            return (Array.isArray(parsed) ? parsed : [parsed]).map((printer) => ({
                name: printer.Name,
                status: String(printer.PrinterStatus || ""),
                isDefault: printer.Default === true
            }));
        } catch (error) {
            console.warn("Unable to list Windows printers:", error.message);
        }
    }
    return [];
}

async function heartbeat() {
    const localPrinters = await listLocalPrinters();
    await apiRequest("/api/print-agent/heartbeat", {
        agentVersion: AGENT_VERSION,
        hostName: os.hostname(),
        localPrinters
    });
}

async function printFile(filePath, printerName) {
    if (PRINT_COMMAND) {
        const command = PRINT_COMMAND
            .replace(/\{file\}/g, shellQuote(filePath))
            .replace(/\{printer\}/g, shellQuote(printerName || ""));
        await runShell(command);
        return;
    }

    if (process.platform === "win32") {
        const script = printerName
            ? `$file=${psSingleQuote(filePath)};$printer=${psSingleQuote(printerName)};Start-Process -FilePath $file -Verb PrintTo -ArgumentList $printer -Wait`
            : `$file=${psSingleQuote(filePath)};Start-Process -FilePath $file -Verb Print -Wait`;
        await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
        return;
    }

    const args = printerName ? ["-d", printerName, filePath] : [filePath];
    await runCommand("lp", args);
}

async function processJob(job) {
    if (!job?.id) return;
    const fileName = safeFileName(job.fileName || `wms365-job-${job.id}.pdf`);
    const filePath = path.join(os.tmpdir(), `wms365-${job.id}-${fileName}`);
    try {
        fs.writeFileSync(filePath, Buffer.from(job.payloadBase64 || "", "base64"));
        console.log(`Printing job ${job.id}: ${job.documentTitle || fileName} -> ${job.printerName || "default printer"}`);
        await printFile(filePath, job.printerName);
        await apiRequest(`/api/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, { success: true, status: "PRINTED" });
        console.log(`Completed print job ${job.id}.`);
    } catch (error) {
        console.error(`Print job ${job.id} failed:`, error.message);
        await apiRequest(`/api/print-agent/jobs/${encodeURIComponent(job.id)}/complete`, {
            success: false,
            status: "FAILED",
            error: error.stderr || error.message || "Print failed"
        });
    } finally {
        if (process.env.WMS365_KEEP_PRINT_FILES !== "1") {
            try { fs.unlinkSync(filePath); } catch (_error) { /* ignore cleanup errors */ }
        }
    }
}

async function pollOnce() {
    const result = await apiRequest("/api/print-agent/jobs/claim", { limit: 1 });
    if (result?.job) {
        await processJob(result.job);
    }
}

async function main() {
    console.log(`WMS365 Print Agent ${AGENT_VERSION}`);
    console.log(`Connecting to ${APP_URL} as ${os.hostname()}`);
    await heartbeat();
    setInterval(() => {
        heartbeat().catch((error) => console.error("Heartbeat failed:", error.message));
    }, HEARTBEAT_MS).unref();

    while (true) {
        try {
            await pollOnce();
        } catch (error) {
            console.error("Print polling failed:", error.message);
            await sleep(Math.min(POLL_MS * 3, 30000));
        }
        await sleep(POLL_MS);
    }
}

main().catch((error) => {
    console.error("Print agent stopped:", error);
    process.exit(1);
});
