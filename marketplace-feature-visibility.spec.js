"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("disabled marketplace feature hides connection controls behind one unavailable state", () => {
    assert.match(warehouse, /id="integrationFeatureUnavailable"[^>]*class="helper hidden"|class="helper hidden" id="integrationFeatureUnavailable"/);
    assert.match(warehouse, /document\.getElementById\("integrationForm"\)\?\.classList\.toggle\("hidden", featureOff\)/);
    assert.match(warehouse, /integrationSavedConnections\?\.classList\.toggle\("hidden", featureOff\)/);
    assert.match(warehouse, /integrationTabLabel\.textContent = featureOff \? "Integrations \(Off\)" : "Integrations"/);
});

test("only super administrators receive the Feature Access recovery action", () => {
    assert.match(warehouse, /id="integrationFeatureAccessBtn"[^>]*class="btn ghost hidden"|class="btn ghost hidden" id="integrationFeatureAccessBtn"/);
    assert.match(warehouse, /integrationFeatureAccessBtn\?\.classList\.toggle\("hidden", !currentUserIsSuperAdmin\(\)\)/);
    assert.match(warehouse, /integrationFeatureAccessBtn\?\.addEventListener\("click", \(\) => openCompanySetupNextStep\("features"\)\)/);
});

test("marketplace writes remain protected by server-side company feature assertions", () => {
    assert.match(server, /assertCompanyFeatureEnabled\([^\n]+COMPANY_FEATURE_KEYS\.STORE_INTEGRATIONS\)/);
    assert.match(server, /assertCompanyFeatureEnabled\([^\n]+COMPANY_FEATURE_KEYS\.SHOPIFY_INTEGRATION\)/);
    assert.match(server, /assertCompanyFeatureEnabled\([^\n]+COMPANY_FEATURE_KEYS\.SFTP_INTEGRATION\)/);
});
