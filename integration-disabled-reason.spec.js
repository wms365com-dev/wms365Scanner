const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const client = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("disabled Shopify and SFTP providers explain why their controls are unavailable", () => {
    assert.match(client, /SHOPIFY_INTEGRATION:[\s\S]*?return `\$\{companyLabel\} does not have Shopify enabled\.`/);
    assert.match(client, /SFTP_INTEGRATION:[\s\S]*?return `\$\{companyLabel\} does not have SFTP enabled\.`/);
    assert.match(client, /providerLocked[\s\S]*?ui\.integrationProviderNote\.textContent[\s\S]*?companyFeatureDisabledMessage\(COMPANY_FEATURE_KEYS\.SFTP_INTEGRATION, company\)[\s\S]*?companyFeatureDisabledMessage\(COMPANY_FEATURE_KEYS\.SHOPIFY_INTEGRATION, company\)/);
});

test("provider feature locks disable connection and sync controls without hiding the reason", () => {
    assert.match(client, /ui\.integrationStoreIdentifier\.disabled = featureLocked \|\| providerLocked/);
    assert.match(client, /ui\.integrationAccessToken\.disabled = featureLocked \|\| providerLocked/);
    assert.match(client, /ui\.integrationSyncBtn\.disabled = [^;]*featureLocked \|\| providerLocked/);
    assert.doesNotMatch(client, /if \(providerLocked\)[\s\S]{0,240}integrationProviderNote\.classList\.add\("hidden"\)/);
});

test("direct Shopify and SFTP integration writes remain server-side feature gated", () => {
    assert.match(server, /assertCompanyFeatureEnabled\([^;]*COMPANY_FEATURE_KEYS\.SHOPIFY_INTEGRATION\)/);
    assert.match(server, /assertCompanyFeatureEnabled\([^;]*COMPANY_FEATURE_KEYS\.SFTP_INTEGRATION\)/);
});
