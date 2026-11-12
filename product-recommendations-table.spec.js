const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("Admin includes a refreshable and exportable recommendation table", () => {
    assert.match(ui, /id="productRecommendationsBody"/);
    assert.match(ui, /id="refreshProductRecommendationsBtn"/);
    assert.match(ui, /id="exportProductRecommendationsBtn"/);
    assert.match(ui, /Acceptance Test/);
});

test("recommendation report is protected by super-admin access", () => {
    assert.match(server, /app\.get\("\/api\/admin\/product-intelligence", requireSuperAdmin\(\)/);
});
