const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const verifier = fs.readFileSync(path.join(__dirname, "scripts", "verify-test-company-profile-edit.js"), "utf8");

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${name} must exist`);
    const bodyStart = source.indexOf(") {", start) + 2;
    assert.ok(bodyStart > 1, `${name} body must exist`);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${name} is incomplete`);
}

const getDestructiveCompanyProfileBlankFields = Function(
    `"use strict"; ${extractFunction(warehouse, "getDestructiveCompanyProfileBlankFields")}; return getDestructiveCompanyProfileBlankFields;`
)();

const getDestructiveOwnerProfileBlankFields = Function(
    `"use strict";
     const normalizeFreeText = (value) => String(value || "").trim();
     const OWNER_PROFILE_EDIT_FIELDS = Object.freeze([
        ["legalName", "legal_name", "Legal Name"], ["email", "email", "Main Email"],
        ["address1", "address1", "Address 1"]
     ]);
     ${extractFunction(server, "getDestructiveOwnerProfileBlankFields")};
     return getDestructiveOwnerProfileBlankFields;`
)();

test("company profile navigation hydrates before enabling edits", () => {
    const hydrate = extractFunction(warehouse, "hydrateActiveCompanyProfileForEdit");
    assert.match(warehouse, /if \(anchorId === "masterOwnerProfileCard"\) \{\s*hydrateActiveCompanyProfileForEdit\(\)\.catch/);
    assert.match(hydrate, /setCompanyProfileFormDisabled\(true\)/);
    assert.ok(hydrate.indexOf("await syncServerState(true)") < hydrate.indexOf("const owner = getCompanyRecord(company)"));
    assert.ok(hydrate.indexOf("loadCompanySetupIntoProfile(owner)") < hydrate.indexOf("setCompanyProfileFormDisabled(false)"));
    assert.match(hydrate, /Nothing can be edited or saved/);
    assert.match(warehouse, /function init\(\) \{\s*applyDeviceExperienceMode\(\);\s*setCompanyProfileFormDisabled\(true\)/);
});

test("company profile save is bound to the hydrated record and version", () => {
    const save = extractFunction(warehouse, "saveMasterOwner");
    assert.match(save, /loadedCompanyProfileSnapshot/);
    assert.match(save, /Load the saved company profile before editing or saving it/);
    assert.match(save, /getDestructiveCompanyProfileBlankFields\(entry, savedProfile\)/);
    assert.match(save, /profileEdit: true/);
    assert.match(save, /expectedUpdatedAt: savedProfile\.updatedAt/);
    assert.match(save, /loadCompanySetupIntoProfile\(refreshedOwner\)/);
    assert.doesNotMatch(save, /masterOwnerForm"\)\.reset/);
});

test("blank overwrite detection identifies only previously populated fields", () => {
    const saved = { legalName: "Saved Legal", email: "saved@example.com", city: "" };
    assert.deepEqual(
        getDestructiveCompanyProfileBlankFields({ legalName: "", email: "new@example.com", city: "" }, saved),
        ["Legal Name"]
    );
    assert.deepEqual(
        getDestructiveCompanyProfileBlankFields({ legalName: "Saved Legal", email: "new@example.com" }, saved),
        []
    );
    assert.deepEqual(
        getDestructiveOwnerProfileBlankFields(
            { legal_name: "Saved Legal", email: "saved@example.com", address1: "" },
            { legalName: "", email: "new@example.com", address1: "" }
        ),
        ["Legal Name"]
    );
});

test("server locks the exact company and rejects stale or blank profile edits", () => {
    const guard = extractFunction(server, "assertCompanyProfileEditReady");
    const routeStart = server.indexOf('app.post("/api/master-owner"');
    const routeEnd = server.indexOf('app.post("/api/fulfillment-location"', routeStart);
    const route = server.slice(routeStart, routeEnd);
    assert.match(route, /assertSuperAdminAccess\(req\.appUser\)/);
    assert.match(route, /if \(req\.body\?\.profileEdit === true\)/);
    assert.ok(route.indexOf("assertCompanyProfileEditReady(client, req.body)") < route.indexOf("upsertOwnerMaster(client, entry)"));
    assert.match(guard, /where name=\$1 limit 1 for update/);
    assert.match(guard, /expectedTimestamp !== currentTimestamp/);
    assert.match(guard, /getDestructiveOwnerProfileBlankFields\(existing, rawInput\)/);
    assert.match(guard, /This company profile changed after it was loaded/);
});

test("sandbox verifier is pinned, authorization-negative, and cleanup-safe", () => {
    assert.match(verifier, /requireSandboxConfiguration\(env\)/);
    assert.match(verifier, /id: "1510", name: "CODEX PORTAL SYSTEM TEST"/);
    assert.match(verifier, /requireDesignatedTestCompany\(pool\)/);
    assert.match(verifier, /if \(denied\.status !== 403\)/);
    assert.match(verifier, /if \(stale\.status !== 409\)/);
    assert.match(verifier, /if \(blank\.status !== 409\)/);
    assert.match(verifier, /update owner_accounts set note=\$2,updated_at=\$3/);
    assert.match(verifier, /delete from app_sessions/);
    assert.match(verifier, /Company-profile verifier cleanup left sandbox residue/);
});
