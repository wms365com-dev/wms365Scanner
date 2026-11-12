const path = require("node:path");
const express = require("express");
const { test, expect } = require("@playwright/test");

let server;
let baseUrl;

test.beforeAll(async () => {
    const app = express();
    app.get("/mobile/login", (_request, response) => response.sendFile(path.join(__dirname, "mobile-login.html")));
    app.get("/portal.html", (_request, response) => response.sendFile(path.join(__dirname, "portal.html")));
    app.get("/mobile-bridge.js", (_request, response) => response.type("application/javascript").send(""));
    app.get("/marketing-logo.svg", (_request, response) => response.type("image/svg+xml").send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#176b4b"/><path d="M14 20h7l4 23 7-18 7 18 4-23h7l-8 30h-7l-7-17-7 17h-7z" fill="white"/></svg>'
    ));
    app.get("/api/app/me", (_request, response) => response.status(401).json({ authenticated: false }));
    app.get("/api/portal/me", (_request, response) => response.status(401).json({ authenticated: false }));
    app.get("/api/build-info", (_request, response) => response.json({ version: "test", build: "login-ui" }));

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function expectMobileLoginLayout(page, heading) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.locator("input[type=email]").first()).toBeVisible();
    await expect(page.locator("input[type=password]").first()).toBeVisible();
    const submit = page.getByRole("button", { name: "Sign in" });
    await expect(submit).toBeVisible();

    const metrics = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        submitHeight: document.querySelector('button[type="submit"]')?.getBoundingClientRect().height || 0,
        emailHeight: document.querySelector('input[type="email"]')?.getBoundingClientRect().height || 0
    }));
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.submitHeight).toBeGreaterThanOrEqual(48);
    expect(metrics.emailHeight).toBeGreaterThanOrEqual(48);
}

test.use({ viewport: { width: 360, height: 800 } });

test("warehouse login is focused and touch friendly", async ({ page }) => {
    await page.goto(`${baseUrl}/mobile/login`);
    await expectMobileLoginLayout(page, "Warehouse Login");
    await expect(page.getByText("Worker access", { exact: true })).toBeVisible();
});

test("customer login is compact and touch friendly", async ({ page }) => {
    await page.goto(`${baseUrl}/portal.html`);
    await expectMobileLoginLayout(page, "Customer Login");
    await expect(page.locator(".auth-intro")).toHaveCount(0);
    await expect(page.locator(".auth-app-brand-copy").getByText("Customer Portal", { exact: true })).toBeVisible();
});
