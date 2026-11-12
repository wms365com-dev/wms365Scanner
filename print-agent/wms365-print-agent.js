"use strict";
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { ConnectorSignIn, Wms365PrintAgent, listLocalPrinters, loadAgentConfiguration, printTestPage, sanitizePrinterMappings, saveAgentConfiguration, ensureDeviceIdentity, protectSecretWindows, unprotectSecretWindows } = require("./wms365-print-agent-core");
const { dashboardHtml } = require("./connector-dashboard");
const { AGENT_VERSION } = require("./wms365-print-agent-core");
const { ConnectorUpdater } = require("./connector-updater");
const HOST = "127.0.0.1";
const PORT = Math.max(1024, Number.parseInt(process.env.WMS365_PRINT_AGENT_PORT || "8765", 10) || 8765);
const CONTROL_TOKEN = crypto.randomBytes(24).toString("hex");
let config, agent, signIn, sessionTimer, updater;
let mutationBusy = false;
let localAccessToken;
const ACCESS_COOKIE = `wms365_connector_access_${PORT}`;
function secureEquals(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function hasLocalAccess(request) {
    const cookie = String(request.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${ACCESS_COOKIE}=`));
    return secureEquals(cookie?.slice(ACCESS_COOKIE.length + 1), localAccessToken);
}
async function loadLocalAccess(dataDir) {
    const accessPath = path.join(dataDir, "loopback-access.json");
    try {
        const value = JSON.parse(fs.readFileSync(accessPath, "utf8"));
        const token = await unprotectSecretWindows(value.protectedToken);
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("The protected local connection needs to be repaired. Contact WMS365 support.");
        return token;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const token = crypto.randomBytes(32).toString("hex");
    const protectedToken = await protectSecretWindows(token);
    fs.mkdirSync(dataDir, { recursive: true });
    try { fs.writeFileSync(accessPath, JSON.stringify({ protectedToken }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; return loadLocalAccess(dataDir); }
    return token;
}

function sendJson(response, status, payload) {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(payload));
}
function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        request.on("data", (chunk) => { size += chunk.length; if (size > 64 * 1024) { reject(new Error("Request is too large.")); request.destroy(); return; } chunks.push(chunk); });
        request.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (_error) { reject(new Error("Invalid request.")); } });
        request.on("error", reject);
    });
}
function isTrustedLocalRequest(request, port = PORT) {
    const expected = `127.0.0.1:${port}`;
    return request.headers.host === expected && (!request.headers.origin || request.headers.origin === `http://${expected}`) && !["cross-site", "same-site"].includes(request.headers["sec-fetch-site"]);
}
async function restartAgent() {
    if (agent?.processing) throw new Error("A document is printing. Wait for it to finish before changing settings.");
    agent?.stop();
    config = await loadAgentConfiguration({ dataDir: config.dataDir });
    agent = new Wms365PrintAgent(config);
    const runningAgent = agent;
    runningAgent.runLoop().catch((error) => { runningAgent.state.status = "OFFLINE"; runningAgent.state.lastError = error.message; });
}
async function expireSignIn() {
    clearTimeout(sessionTimer);
    const previous = signIn; signIn = null;
    if (previous) await previous.logout();
}
async function handleRequest(request, response) {
    if (!isTrustedLocalRequest(request)) return sendJson(response, 403, { error: "Access restricted. Open the connector from its desktop shortcut." });
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { version: AGENT_VERSION, processId: process.pid });
    if (request.method === "POST" && url.pathname === "/api/unlock") {
        const body = await readJsonBody(request);
        if (!secureEquals(body.token, localAccessToken)) return sendJson(response, 403, { error: "Access restricted. Open your connector desktop shortcut." });
        response.setHeader("Set-Cookie", `${ACCESS_COOKIE}=${localAccessToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
        return sendJson(response, 200, { unlocked: true });
    }
    if (request.method === "GET" && url.pathname === "/") {
        const nonce = crypto.randomBytes(18).toString("base64");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
        if (!hasLocalAccess(request)) return response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WMS365 Print Connector</title></head><body><h1>WMS365 Print Connector</h1><p id="message" role="alert">Access restricted. Open your connector desktop shortcut.</p><script nonce="${nonce}">const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(token)fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(r.ok)location.reload();else document.getElementById('message').textContent='Access restricted. Open your connector desktop shortcut.'}).catch(()=>{document.getElementById('message').textContent='The connector is unavailable. Open your desktop shortcut again.'});</script></body></html>`);
        return response.end(dashboardHtml(nonce, CONTROL_TOKEN, config));
    }
    if (request.method === "GET" && url.pathname === "/logo.svg") {
        response.writeHead(200, { "Content-Type": "image/svg+xml", "X-Content-Type-Options": "nosniff" });
        return response.end(fs.readFileSync(path.join(__dirname, "logo.svg")));
    }
    if (!hasLocalAccess(request)) return sendJson(response, 403, { error: "Access restricted. Open your connector desktop shortcut." });
    if (request.headers["x-wms365-local-control"] !== CONTROL_TOKEN) return sendJson(response, 403, { error: "Local control check failed. Refresh this page." });
    if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, 200, { ...agent.publicStatus(), update: updater?.state });
    if (request.method !== "POST") return sendJson(response, 404, { error: "Not found." });
    if (mutationBusy) return sendJson(response, 409, { error: "Another action is running. Please wait for it to finish." });
    if (updater?.busy) return sendJson(response, 409, { error: "An update check or installation is running. Please wait." });
    if (url.pathname === "/api/updates") {
        await readJsonBody(request);
        await updater.tick(agent, () => mutationBusy, () => setTimeout(() => process.exit(0), 1000));
        return sendJson(response, 200, updater.state);
    }
    mutationBusy = true;
    try {
        const body = await readJsonBody(request);
        if (["/api/config", "/api/enroll", "/api/disconnect", "/api/quit"].includes(url.pathname)) {
            if (agent.processing) throw new Error("A document is printing. Please wait for it to finish.");
            agent.paused = true;
        }
        if (url.pathname === "/api/login") {
            await expireSignIn();
            signIn = new ConnectorSignIn(config.appUrl, global.fetch, () => ensureDeviceIdentity(config));
            const result = await signIn.login(String(body.email || ""), String(body.password || ""));
            sessionTimer = setTimeout(() => { void expireSignIn(); }, 5 * 60 * 1000); sessionTimer.unref();
            return sendJson(response, 200, result);
        }
        if (url.pathname === "/api/enroll") {
            if (!signIn) throw new Error("Sign in to WMS365 first.");
            if (agent.processing) throw new Error("A document is printing. Please wait.");
            const result = await signIn.enroll({ fulfillmentLocationId: body.fulfillmentLocationId, installationId: config.installationId, hostName: agent.hostname });
            await expireSignIn();
            await saveAgentConfiguration({ ...config, credentialExpiresAt: result.credentialExpiresAt }, { stationToken: result.setupToken });
            await restartAgent();
            agent.state.station = result.station;
            return sendJson(response, 200, { connected: true, station: result.station });
        }
        if (url.pathname === "/api/disconnect") {
            if (agent.processing) throw new Error("A document is printing. Please wait.");
            await expireSignIn();
            let warning = "";
            if (config.stationToken) {
                try { await agent.apiRequest("/api/print-agent/disconnect"); }
                catch (_error) { warning = "Signed out on this computer. WMS365 could not confirm remote disconnection. Ask your administrator to disable this station if needed."; }
            }
            delete process.env.WMS365_PRINT_STATION_TOKEN;
            await saveAgentConfiguration(config, { clearToken: true });
            await restartAgent();
            return sendJson(response, 200, { disconnected: true, warning });
        }
        if (url.pathname === "/api/config") {
            if (agent.processing) throw new Error("A document is printing. Please wait.");
            const nextConfig = { ...config, printerMappings: sanitizePrinterMappings(body.printerMappings), documentPrinterName: String(body.documentPrinterName || "").trim(), labelPrinterName: String(body.labelPrinterName || "").trim() };
            const installed = new Set((await listLocalPrinters()).map((printer) => printer.name));
            for (const printer of [nextConfig.documentPrinterName, nextConfig.labelPrinterName, ...Object.values(nextConfig.printerMappings)]) if (printer && !installed.has(printer)) throw new Error(`Printer "${printer}" is not installed. Refresh the printer list.`);
            await saveAgentConfiguration(nextConfig);
            await restartAgent();
            let warning = "";
            if (config.stationToken) {
                try { await agent.heartbeat(); }
                catch (_error) { warning = "Printer choices saved on this computer. WMS365 could not confirm them yet; they will synchronize when the connection returns."; }
            }
            return sendJson(response, 200, { saved: true, warning });
        }
        if (url.pathname === "/api/printers") return sendJson(response, 200, { printers: await listLocalPrinters() });
        if (url.pathname === "/api/test-print") {
            const name = String(body.printerName || "");
            if (!(await listLocalPrinters()).some((printer) => printer.name === name)) throw new Error("Choose an installed printer first.");
            await printTestPage(name);
            return sendJson(response, 200, { printed: true });
        }
        if (url.pathname === "/api/check") { await agent.heartbeat(); await agent.pollOnce(); return sendJson(response, 200, { checked: true }); }
        if (url.pathname === "/api/quit") {
            await expireSignIn(); agent.stop();
            sendJson(response, 200, { closed: true });
            setTimeout(() => process.exit(0), 500);
            return;
        }
        sendJson(response, 404, { error: "Not found." });
    } finally { mutationBusy = false; agent.paused = false; }
}
function openDashboard() {
    if (!process.argv.includes("--background")) execFile("cmd.exe", ["/c", "start", "", `http://${HOST}:${PORT}/#${localAccessToken}`], { windowsHide: true }, () => {});
}
async function main() {
    config = await loadAgentConfiguration(); await saveAgentConfiguration(config);
    localAccessToken = await loadLocalAccess(config.dataDir);
    agent = new Wms365PrintAgent(config);
    updater = new ConnectorUpdater({ installDir: __dirname, dataDir: config.dataDir, version: AGENT_VERSION });
    const checkUpdates = () => { void updater.tick(agent, () => mutationBusy); };
    const updateTimer = setInterval(checkUpdates, 60 * 60 * 1000); updateTimer.unref();
    const idleUpdateTimer = setInterval(() => { if (updater.state.status === "WAITING_FOR_PRINTING") checkUpdates(); }, 30000); idleUpdateTimer.unref();
    const initialUpdateTimer = setTimeout(checkUpdates, 30000); initialUpdateTimer.unref();
    const server = http.createServer((request, response) => { handleRequest(request, response).catch((error) => sendJson(response, 400, { error: error.message || "Request failed." })); });
    server.on("error", (error) => { if (error.code === "EADDRINUSE") { openDashboard(); process.exit(0); } throw error; });
    server.listen(PORT, HOST, () => {
        const runningAgent = agent;
        runningAgent.runLoop().catch(error => { runningAgent.state.status = "OFFLINE"; runningAgent.state.lastError = error.message; });
        console.log(`WMS365 Print Agent is running at http://${HOST}:${PORT}`); openDashboard();
    });
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { handleRequest, main, readJsonBody, isTrustedLocalRequest, loadLocalAccess, secureEquals };
