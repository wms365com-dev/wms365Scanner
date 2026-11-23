const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const verifier = fs.readFileSync(path.join(__dirname, "scripts", "verify-test-company-password-reset-browser.js"), "utf8");

test("password reset browser verifier is pinned to the isolated customer sandbox", () => {
    assert.match(verifier, /ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6/);
    assert.match(verifier, /98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b/);
    assert.match(verifier, /wms365-sandbox-customer-sandbox\.up\.railway\.app/);
    assert.match(verifier, /id: "1510", name: "CODEX PORTAL SYSTEM TEST"/);
});

test("password reset browser verifier tests only the safe cancel path", () => {
    assert.match(verifier, /#accountResetPasswordBtn/);
    assert.match(verifier, /Reset your password\?/);
    assert.match(verifier, /button\[data-action-confirm-cancel\]/);
    assert.match(verifier, /recoveryPosts !== 0/);
    assert.doesNotMatch(verifier, /locator\("\[data-action-confirm-accept\]"\)\.click/);
});

test("password reset browser verifier cleans up and proves zero residue", () => {
    assert.match(verifier, /fixtureCleanupSource/);
    assert.match(verifier, /fixtureResidueSource/);
    assert.match(verifier, /delete from app_sessions/);
    assert.match(verifier, /delete from app_users/);
    assert.match(verifier, /if \(residue\.users\)/);
});
