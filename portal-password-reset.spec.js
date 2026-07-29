const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
    buildPortalResetLinkEmailHtml,
    buildPortalResetLinkEmailText,
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
        expiresInMinutes: 30,
        signupUrl: "https://wms365.co/pricing"
    };
    const text = buildPortalResetLinkEmailText(input);
    const html = buildPortalResetLinkEmailHtml(input);
    assert.match(text, /one-time link expires in 30 minutes/i);
    assert.match(text, /reset_token=abc123/);
    assert.match(html, /Choose a new password/);
    assert.doesNotMatch(`${text}${html}`, /Temporary password:/i);
});
