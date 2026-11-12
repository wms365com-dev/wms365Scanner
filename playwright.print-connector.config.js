const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({ testDir: "./print-agent", testMatch: "connector-visual.spec.js", workers: 1, timeout: 30000, use: { headless: true, browserName: "chromium" }, reporter: "list" });
