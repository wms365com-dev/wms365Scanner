const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("settings provides an authenticated warehouse profile editor", () => {
    assert.match(server, /app\.put\("\/api\/app\/profile"/);
    assert.match(server, /const session = await requireAppSession\(req\)/);
    assert.match(server, /where id=\$1 returning \*/);
    assert.match(desktop, /id="accountProfileBtn"/);
    assert.match(desktop, /id="accountProfileFirstName"/);
    assert.match(desktop, /id="accountProfileLastName"/);
    assert.match(desktop, /id="accountProfilePhone"/);
    assert.match(desktop, /id="accountProfileEmail" type="email" readonly/);
    assert.match(desktop, /id="accountProfileRole" type="text" readonly/);
});

test("password reset loads the signed-in user and has a working click action", () => {
    assert.match(desktop, /let currentAppUser = null/);
    assert.match(desktop, /async function refreshCurrentAppUser/);
    assert.match(desktop, /requestJson\("\/api\/app\/me"\)/);
    assert.match(desktop, /accountResetPasswordBtn\?\.addEventListener\("click", resetCurrentWarehousePassword\)/);
    assert.match(desktop, /requestJson\("\/api\/app\/recovery\/password"/);
});

test("profile schema stores names and phone without exposing access controls", () => {
    assert.match(server, /add column if not exists first_name/);
    assert.match(server, /add column if not exists last_name/);
    assert.match(server, /add column if not exists phone/);
    assert.doesNotMatch(server.match(/app\.put\("\/api\/app\/profile"[\s\S]*?\n\}\);/)?.[0] || "", /role\s*=|email\s*=|is_active\s*=/i);
});
