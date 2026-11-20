const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const index = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function readFunction(name, nextName) {
    const start = index.indexOf(`        function ${name}`);
    const end = index.indexOf(`        function ${nextName}`, start + 1);
    assert.ok(start >= 0 && end > start, `Could not extract ${name}.`);
    return index.slice(start, end);
}

const formatterSource = readFunction("formatAuthenticatedSessionRole", "syncWarehouseUserAssignedDraftFromUi");

function formatRole({ sessionRole = "", bootstrapRole = "" } = {}) {
    return new Function("context", `
        const state = context.state;
        const norm = context.norm;
        const getCurrentAppUser = context.getCurrentAppUser;
        const warehouseUserRoleLabel = context.warehouseUserRoleLabel;
        ${formatterSource}
        return formatAuthenticatedSessionRole();
    `)({
        state: { session: { appUser: sessionRole ? { role: sessionRole } : null } },
        norm: (value) => String(value || "").trim().toUpperCase(),
        getCurrentAppUser: () => bootstrapRole ? { role: bootstrapRole } : null,
        warehouseUserRoleLabel: (role) => ({
            SUPER_ADMIN: "Super User",
            ADMIN: "Admin",
            WAREHOUSE_ADMIN: "Warehouse Admin",
            WAREHOUSE_WORKER: "Warehouse Worker"
        })[role] || "Warehouse Worker"
    });
}

test("hydrated session role is the authoritative header role", () => {
    assert.equal(formatRole({ sessionRole: "warehouse_admin", bootstrapRole: "warehouse_worker" }), "Warehouse Admin");
});

test("authenticated bootstrap role is shown while server state hydrates", () => {
    assert.equal(formatRole({ bootstrapRole: "super_admin" }), "Super User");
});

test("missing session identity never fabricates warehouse-worker access", () => {
    assert.equal(formatRole(), "Signed in user");
});

test("header formatter is display-only and uses existing authenticated session reads", () => {
    const activeCompanyUi = readFunction("updateActiveCompanyUi", "renderCompanySelectionRecovery");
    assert.match(activeCompanyUi, /formatAuthenticatedSessionRole\(\)/);
    assert.doesNotMatch(activeCompanyUi, /appUser\?\.role \|\| "WAREHOUSE_WORKER"/);
    assert.match(index, /const payload = await requestJson\("\/api\/app\/me"\)/);
    assert.match(index, /state\.session = \{[\s\S]*appUser: payload\?\.session\?\.appUser/);
});
