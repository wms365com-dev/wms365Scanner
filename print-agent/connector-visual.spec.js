const { test, expect } = require("@playwright/test");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
let fakeWms, child, dataDir, disconnectUnavailable = false, accessToken;
const { unprotectSecretWindows } = require("./wms365-print-agent-core");
const { verifyProof } = require("./connector-security");
let enrolledDevice;
const usedProofs = new Set();
const base = "http://127.0.0.1:8875";
const output = path.resolve(__dirname, "../outputs/print-connector");

test.beforeAll(async () => {
    fs.mkdirSync(output, { recursive: true });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wms365-connector-visual-"));
    fakeWms = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (part) => chunks.push(part));
        req.on("end", async () => {
            req.rawBody = Buffer.concat(chunks);
            const body = chunks.length ? JSON.parse(req.rawBody.toString()) : {};
            res.setHeader("Content-Type", "application/json");
            if (req.url.endsWith("/enroll") || req.url.startsWith("/api/print-agent/")) {
                try {
                    const proof = await verifyProof(req, { url: "http://127.0.0.1:8876" + req.url, installationId: req.url.endsWith("/enroll") ? body.installationId : enrolledDevice?.installationId, ...(req.url.endsWith("/enroll") ? {} : { token: "test-not-a-production-token", keyThumbprint: enrolledDevice?.thumbprint }) });
                    if (usedProofs.has(proof.jti)) throw new Error("Access restricted. Replayed test request.");
                    usedProofs.add(proof.jti);
                    if (req.url.endsWith("/enroll")) enrolledDevice = { thumbprint: proof.thumbprint, installationId: body.installationId };
                } catch (error) { res.writeHead(403); return res.end(JSON.stringify({ error: error.message })); }
            }
            if (disconnectUnavailable && req.url.endsWith("/disconnect")) { res.writeHead(401); return res.end(JSON.stringify({ error: "Station was revoked." })); }
            if (req.url.endsWith("/login")) {
                if (body.password !== "fake-test-password") { res.writeHead(401); return res.end(JSON.stringify({ error: "The password was not accepted." })); }
                res.setHeader("Set-Cookie", "test_wms_session=local-test; HttpOnly; Path=/");
            }
            if (req.url.endsWith("/warehouses")) {
                if (!req.headers.cookie) { res.writeHead(401); return res.end("{}"); }
                return res.end(JSON.stringify({ warehouses: [{ id: "77", code: "TEST-WAREHOUSE", name: "WMS365 Test Warehouse" }] }));
            }
            if (req.url.endsWith("/enroll")) {
                if (body.fulfillmentLocationId !== "77") { res.writeHead(403); return res.end(JSON.stringify({ error: "Access restricted." })); }
                return res.end(JSON.stringify({ setupToken: "test-not-a-production-token", tokenType: "DPoP", credentialExpiresAt: new Date(Date.now() + 86400000).toISOString(), station: { id: "55", fulfillmentLocationName: "WMS365 Test Warehouse" } }));
            }
            if (req.url.endsWith("/heartbeat")) return res.end(JSON.stringify({ station: { id: "55", fulfillmentLocationName: "WMS365 Test Warehouse" } }));
            res.end("{}");
        });
    });
    await new Promise((resolve) => fakeWms.listen(8876, "127.0.0.1", resolve));
    child = spawn(process.execPath, [path.join(__dirname, "wms365-print-agent.js"), "--background"], {
        env: { ...process.env, WMS365_PRINT_STATION_TOKEN: "", WMS365_APP_URL: "http://127.0.0.1:8876", WMS365_PRINT_AGENT_PORT: "8875", WMS365_PRINT_AGENT_DATA_DIR: dataDir }, windowsHide: true
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs += data; });
    child.stderr.on("data", (data) => { logs += data; });
    for (let attempt = 0; attempt < 60; attempt++) {
        try { if ((await fetch(base)).ok) { accessToken = await unprotectSecretWindows(JSON.parse(fs.readFileSync(path.join(dataDir, "loopback-access.json"), "utf8")).protectedToken); return; } } catch (_error) { /* Wait for the test connector. */ }
        if (child.exitCode !== null) throw new Error(logs);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Test connector did not start: ${logs}`);
});
test.afterAll(async () => {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    if (fakeWms) await new Promise((resolve) => fakeWms.close(resolve));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("desktop sign-in and warehouse registration with visible errors", async ({ page, request }) => {
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.route("**/api/printers", (route) => route.fulfill({ json: { printers: [{ name: "TEST LETTER" }, { name: "TEST LABEL" }] } }));
    await page.goto(base + '/#' + accessToken);
    await expect(page.getByRole("heading", { name: "Sign in to connect" })).toBeVisible();
    await expect(page.locator("[data-type]")).toHaveCount(8);
    expect(await page.locator("header img").evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: path.join(output, "connector-desktop.png"), fullPage: true });
    await page.getByLabel("WMS365 email").fill("worker@test.invalid");
    await page.getByLabel("Password", { exact: true }).fill("wrong-test-password");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("password was not accepted");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    const alertBox = await page.getByRole("alert").boundingBox(); expect(alertBox.y).toBeLessThan(150);
    await page.getByLabel("Password", { exact: true }).fill("fake-test-password");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByLabel("Warehouse", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Connect This Computer" }).click();
    await expect(page.locator("#assigned")).toHaveText("WMS365 Test Warehouse", { timeout: 10000 });
    await page.screenshot({ path: path.join(output, "connector-connected.png"), fullPage: true });
    expect((await request.get(base + "/api/status")).status()).toBe(403);
    expect(await (await request.get(base)).text()).not.toContain('X-WMS365-Local-Control');
    expect((await request.get(base, { headers: { Host: "evil.example:8875" } })).status()).toBe(403);
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to connect" })).toBeVisible();
    expect(errors).toEqual([]);
});

test("revoked cloud credential cannot trap a user in the local signed-in state", async ({ page }) => {
    await page.goto(base + '/#' + accessToken);
    await page.getByLabel("WMS365 email").fill("worker@test.invalid");
    await page.getByLabel("Password", { exact: true }).fill("fake-test-password");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.getByRole("button", { name: "Connect This Computer" }).click();
    await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible({ timeout: 15000 });
    disconnectUnavailable = true;
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page.getByRole("alert")).toContainText("Signed out on this computer");
    await expect(page.getByRole("heading", { name: "Sign in to connect" })).toBeVisible();
    disconnectUnavailable = false;
});

test("mobile setup is readable without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/printers", (route) => route.fulfill({ json: { printers: [{ name: "TEST LETTER" }, { name: "TEST LABEL" }] } }));
    await page.goto(base + '/#' + accessToken); await expect(page.locator("#letter option")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(output, "connector-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Test", exact: true }).first().click();
    await expect(page.getByRole("alert")).toHaveText("Choose a printer first.");
    expect((await page.getByRole("alert").boundingBox()).y).toBeLessThan(150);
});
