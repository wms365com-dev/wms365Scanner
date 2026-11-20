const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("FactBox values use bounded wrapping columns instead of intrinsic-width overlap", () => {
    assert.match(desktop, /\.factbox-line\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 5rem\) minmax\(0, 1fr\)/);
    assert.match(desktop, /\.factbox-line strong\s*\{[\s\S]*?min-width:\s*0[\s\S]*?overflow-wrap:\s*anywhere/);
});

test("FactBox preserves the complete value in a tooltip on every generated row", () => {
    const start = desktop.indexOf("function renderDesktopFactboxLines");
    const renderer = start >= 0 ? desktop.slice(start, start + 700) : "";
    assert.match(renderer, /<strong title="\$\{attr\(line\.value\)\}">\$\{esc\(line\.value\)\}<\/strong>/);
});

test("inventory, reports, and marketplace contexts continue to use the shared safe renderer", () => {
    assert.match(desktop, /activeSection === "inventory"[\s\S]*?label: "Company", value: company/);
    assert.match(desktop, /activeSection === "integrations"[\s\S]*?title = "Marketplace Connections"[\s\S]*?label: "Company", value: company/);
    assert.match(desktop, /desktopFactboxContextBody\.innerHTML = renderDesktopFactboxLines\(lines\)/);
});
