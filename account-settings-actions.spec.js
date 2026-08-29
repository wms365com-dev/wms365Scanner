const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("warehouse Settings menu exposes password reset and logout", () => {
    assert.match(source, /id="accountSettingsMenu"/);
    assert.match(source, /id="accountResetPasswordBtn"/);
    assert.match(source, /id="accountLogoutBtn"/);
    assert.match(source, /\/api\/app\/recovery\/password/);
    assert.match(source, /\/api\/app\/logout/);
});

test("password reset warns that all warehouse sessions will end", () => {
    assert.match(source, /signed out on every device/);
    assert.match(source, /temporary password has been emailed/i);
});
