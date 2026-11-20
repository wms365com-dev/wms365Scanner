const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const screenMap = fs.readFileSync(path.join(__dirname, "docs", "WAREHOUSE_SCREEN_FEATURE_MAP.md"), "utf8");

function moduleBarSource() {
    return source.slice(source.indexOf('<div class="desktop-modulebar'), source.indexOf('<div class="desktop-embeddingbar'));
}

function directorySource() {
    const start = source.indexOf('<details class="home-directory-details">');
    return source.slice(start, source.indexOf('</details>', start) + 10);
}

test("module bar uses the canonical workflow information architecture", () => {
    const moduleBar = moduleBarSource();
    assert.deepEqual(
        [...moduleBar.matchAll(/<summary>([^<]+)<\/summary>/g)].map((match) => match[1]),
        ["Home", "Inbound", "Inventory", "Outbound", "Setup", "Reporting", "Commercial", "System"]
    );
    assert.doesNotMatch(moduleBar, /<summary>(Finance|Cash Management|Sales|Purchasing|Shopify|Menu)<\/summary>/);
    assert.match(screenMap, /Home, Inbound, Inventory, Outbound, Setup, Reporting, Commercial, System/);
});

test("every canonical Directory target is one real clickable row", () => {
    const directory = directorySource();
    for (const section of ["scan", "inbounds", "search", "actions", "labels", "orders", "work-orders", "shipped", "reports", "inventory", "integrations", "billing", "backup"]) {
        assert.match(directory, new RegExp(`<button[^>]+data-jump-section="${section}"[^>]*>`));
    }
    assert.doesNotMatch(directory, /class="home-task"(?![^>]*type="button")/);
    assert.match(source, /\.home-task::after\s*\{[\s\S]*border:\s*1px solid #aebfce[\s\S]*border-radius:\s*4px/);
});

test("Marketplace Connections naming is consistent across menu, Directory, page, and docs", () => {
    assert.match(moduleBarSource(), />Marketplace Connections<\/button>/);
    assert.match(directorySource(), /<strong>Marketplace Connections<\/strong>/);
    assert.match(source, /<h2>Marketplace Connections<\/h2>/);
    assert.match(screenMap, /Use Marketplace Connections consistently/);
    assert.doesNotMatch(moduleBarSource(), />Store Integrations<\/button>|>Integrations<\/button>/);
});

test("navigation renaming preserves existing role and feature restrictions", () => {
    assert.match(source, /querySelectorAll\('\[data-section="billing-finance"\], \[data-jump-section="billing-finance"\]'\)/);
    assert.match(source, /node\.hidden = !sessionPending && !allowed/);
    assert.match(source, /does not have Marketplace Connections enabled/);
    assert.match(source, /integrationFeatureAccessBtn\?\.classList\.toggle\("hidden", !currentUserIsSuperAdmin\(\)\)/);
});
