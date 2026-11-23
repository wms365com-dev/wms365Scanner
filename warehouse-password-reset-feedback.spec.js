const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function functionBlock(name, nextName) {
    const start = ui.indexOf(`async function ${name}`);
    const end = ui.indexOf(`function ${nextName}`, start);
    assert.ok(start >= 0 && end > start, `${name} function block must exist`);
    return ui.slice(start, end);
}

test("warehouse password reset uses the accessible in-app confirmation", () => {
    const block = functionBlock("resetCurrentWarehousePassword", "logoutCurrentWarehouseUser");
    assert.match(block, /await confirmWarehouseAction\(\{/);
    assert.match(block, /title: "Reset your password\?"/);
    assert.match(block, /confirmLabel: "Send temporary password"/);
    assert.doesNotMatch(block, /window\.(?:confirm|alert)\(/);
});

test("password reset exposes progress, success, and failure before redirecting", () => {
    const block = functionBlock("resetCurrentWarehousePassword", "logoutCurrentWarehouseUser");
    assert.match(block, /progressMessage: "Creating a secure temporary password and sending it by email\.\.\."/);
    assert.match(block, /response\?\.message \|\| "A temporary password has been emailed\./);
    assert.match(block, /"success"/);
    assert.match(block, /window\.setTimeout\(\(\) => window\.location\.assign\("\/login\.html\?next=%2Fdesktop"\), 1200\)/);
    assert.match(block, /The password reset email could not be sent\./);
});

test("password reset retains the existing signed-in identity and recovery endpoint", () => {
    const block = functionBlock("resetCurrentWarehousePassword", "logoutCurrentWarehouseUser");
    assert.match(block, /currentAppUser\?\.email/);
    assert.match(block, /requestJson\("\/api\/app\/recovery\/password", \{/);
    assert.match(block, /method: "POST"/);
    assert.match(block, /body: JSON\.stringify\(\{ email \}\)/);
});
