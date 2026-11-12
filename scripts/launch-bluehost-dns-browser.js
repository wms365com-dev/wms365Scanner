"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

async function main() {
    const profileDir = path.resolve(__dirname, "..", ".codex-tmp", "bluehost-dns-profile");
    fs.mkdirSync(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
        channel: "msedge",
        headless: false,
        viewport: null,
        args: ["--start-maximized", "--remote-debugging-port=9222"]
    });

    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://www.bluehost.com/my-account/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });
    console.log("BLUEHOST_PLAYWRIGHT_READY http://127.0.0.1:9222");

    const close = async () => {
        await context.close().catch(() => {});
        process.exit(0);
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    process.stdin.resume();
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
