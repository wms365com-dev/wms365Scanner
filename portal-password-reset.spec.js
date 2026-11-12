const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
    buildPortalResetLinkEmailHtml,
    buildPortalResetLinkEmailText,
    buildPortalRecoveryGenericResponse,
    validatePortalResetPassword
} = require("./server");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");

test("customer portal reset form and inline script are present and valid", () => {
    assert.match(portalHtml, /id="portalPasswordResetForm"/);
    assert.match(portalHtml, /id="portalNewPassword"/);
    assert.match(portalHtml, /\/api\/portal\/recovery\/password\/complete/);
    const scripts = [...portalHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    scripts.forEach((match) => new vm.Script(match[1]));
});

test("customer password policy accepts a strong password", () => {
    assert.equal(validatePortalResetPassword("StrongPassword9!"), "StrongPassword9!");
});

test("customer password policy rejects weak passwords", () => {
    assert.throws(() => validatePortalResetPassword("short"), /between 12 and 128/i);
    assert.throws(() => validatePortalResetPassword("alllowercase123!"), /uppercase letter/i);
});

test("password reset email uses a one-time link and never includes a temporary password", () => {
    const input = {
        accessLabel: "Customer Portal",
        resetUrl: "https://app.wms365.co/portal.html?reset_token=abc123",
        username: "customer@example.com",
        expiresInMinutes: 24 * 60,
        signupUrl: "https://wms365.co/pricing"
    };
    const text = buildPortalResetLinkEmailText(input);
    const html = buildPortalResetLinkEmailHtml(input);
    assert.match(text, /one-time link expires in 1 day/i);
    assert.match(text, /reset_token=abc123/);
    assert.match(html, /Choose a new password/);
    assert.doesNotMatch(`${text}${html}`, /Temporary password:/i);
});

test("customer portal recovery response never confirms whether an account exists", () => {
    const response = buildPortalRecoveryGenericResponse();
    assert.equal(response.success, true);
    assert.match(response.message, /if a customer portal account exists/i);
    assert.match(response.message, /email will be sent/i);
    assert.doesNotMatch(response.message, /registered|not found|does not exist|sign up|pricing/i);
    assert.doesNotMatch(portalHtml, /No registered customer portal user was found/i);
});
