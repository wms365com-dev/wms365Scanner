const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function rootBlock() {
    const start = ui.indexOf(":root {");
    const end = ui.indexOf("\n        }", start);
    assert.ok(start >= 0 && end > start, "root design-token block must exist");
    return ui.slice(start, end);
}

test("shared token layer defines semantic color type spacing radius and elevation values", () => {
    const root = rootBlock();
    [
        "--font-family-base:",
        "--color-neutral-background-1:",
        "--color-neutral-foreground-1:",
        "--color-brand-background:",
        "--color-status-success:",
        "--spacing-md:",
        "--border-radius-medium:",
        "--shadow-2:"
    ].forEach((token) => assert.ok(root.includes(token), `${token} must be defined`));
});

test("legacy application variables remain compatibility aliases instead of duplicate values", () => {
    const root = rootBlock();
    assert.match(root, /--bg: var\(--color-neutral-background-3\)/);
    assert.match(root, /--panel: var\(--color-neutral-background-1\)/);
    assert.match(root, /--brand: var\(--color-brand-background\)/);
    assert.match(root, /--ok: var\(--color-status-success\)/);
    assert.match(root, /--radius-sm: var\(--border-radius-medium\)/);
    assert.match(root, /--shadow: var\(--shadow-2\)/);
});

test("core UI consumes the shared typography and focus tokens", () => {
    assert.match(ui, /font-family: var\(--font-family-base\)/);
    assert.match(ui, /border-color: var\(--color-focus-stroke\)/);
    assert.match(ui, /box-shadow: 0 0 0 2px var\(--color-focus-ring\)/);
});

test("token rollout adds no webfont or external UI framework", () => {
    assert.doesNotMatch(ui, /@font-face/i);
    assert.doesNotMatch(ui, /fonts\.(?:googleapis|gstatic)\.com/i);
    assert.doesNotMatch(ui, /(?:fluentui|bootstrap|tailwind)(?:\.min)?\.(?:css|js)/i);
});
