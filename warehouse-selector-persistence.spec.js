const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function readFunction(name, nextName) {
    const start = desktop.indexOf(`        function ${name}`);
    const end = desktop.indexOf(`        function ${nextName}`, start + 1);
    assert.ok(start >= 0 && end > start, `Could not extract ${name}.`);
    return desktop.slice(start, end);
}

function createHarness() {
    const refreshSource = readFunction("refreshActiveWarehouseSelector", "getActiveWarehouseAssignment");
    const setSource = readFunction("setActiveWarehouse", "normalizeProvinceCode");
    const create = new Function("context", `
        let appSessionStateLoaded = context.appSessionStateLoaded;
        const ui = context.ui;
        const state = context.state;
        const norm = context.norm;
        const attr = context.attr;
        const esc = context.esc;
        const getAuthorizedCompanyWarehouseAssignments = context.getAuthorizedCompanyWarehouseAssignments;
        const getFulfillmentLocationByCode = context.getFulfillmentLocationByCode;
        const getActiveCompany = context.getActiveCompany;
        const updateActiveCompanyUi = context.updateActiveCompanyUi;
        const saveState = context.saveState;
        const refreshCompanyScopedUi = context.refreshCompanyScopedUi;
        const refreshPortalOrdersList = context.refreshPortalOrdersList;
        const refreshPortalInboundsList = context.refreshPortalInboundsList;
        const refreshKittingRequestsAdmin = context.refreshKittingRequestsAdmin;
        const refreshWarehouseTasksList = context.refreshWarehouseTasksList;
        let activeSection = "orders";
        ${refreshSource}
        ${setSource}
        return {
            refreshActiveWarehouseSelector,
            setActiveWarehouse,
            setHydrated(value) { appSessionStateLoaded = value; }
        };
    `);
    const calls = { save: 0, rerender: 0, refresh: 0 };
    const state = { preferences: { activeWarehouseCode: "W2" } };
    const ui = {
        activeWarehouse: { value: "", innerHTML: "", disabled: false },
        mobileActiveWarehouse: { value: "", innerHTML: "", disabled: false }
    };
    let assignments = [];
    const resolved = create({
        appSessionStateLoaded: false,
        ui,
        state,
        norm: (value) => String(value || "").trim().toUpperCase(),
        attr: (value) => String(value || ""),
        esc: (value) => String(value || ""),
        getAuthorizedCompanyWarehouseAssignments: () => assignments,
        getFulfillmentLocationByCode: () => ({}),
        getActiveCompany: () => "CODEX PORTAL SYSTEM TEST",
        updateActiveCompanyUi: () => resolved.refreshActiveWarehouseSelector(),
        saveState: () => { calls.save += 1; },
        refreshCompanyScopedUi: () => { calls.rerender += 1; },
        refreshPortalOrdersList: async () => { calls.refresh += 1; },
        refreshPortalInboundsList: async () => {},
        refreshKittingRequestsAdmin: async () => {},
        refreshWarehouseTasksList: async () => {}
    });
    return {
        ...resolved,
        state,
        ui,
        calls,
        setAssignments(value) { assignments = value; }
    };
}

test("pre-hydration rendering preserves the warehouse saved for reload", () => {
    const harness = createHarness();
    harness.refreshActiveWarehouseSelector();
    assert.equal(harness.state.preferences.activeWarehouseCode, "W2");
    assert.equal(harness.ui.activeWarehouse.disabled, true);

    harness.setAssignments([
        { locationCode: "W1", locationName: "Primary", fulfillmentLocationId: "1", isPrimary: true },
        { locationCode: "W2", locationName: "Saved", fulfillmentLocationId: "2", isPrimary: false }
    ]);
    harness.setHydrated(true);
    harness.refreshActiveWarehouseSelector();
    assert.equal(harness.ui.activeWarehouse.value, "W2");
    assert.equal(harness.ui.mobileActiveWarehouse.value, "W2");
    assert.equal(harness.state.preferences.activeWarehouseCode, "W2");
    assert.equal(harness.ui.activeWarehouse.disabled, false);
});

test("the first authorized warehouse selection persists without a company toggle", () => {
    const harness = createHarness();
    harness.state.preferences.activeWarehouseCode = "";
    harness.setAssignments([
        { locationCode: "W1", locationName: "Primary", fulfillmentLocationId: "1", isPrimary: true },
        { locationCode: "W2", locationName: "Selected", fulfillmentLocationId: "2", isPrimary: false }
    ]);
    harness.setHydrated(true);
    harness.setActiveWarehouse("W2");
    assert.equal(harness.state.preferences.activeWarehouseCode, "W2");
    assert.equal(harness.ui.activeWarehouse.value, "W2");
    assert.equal(harness.calls.save, 1);
    assert.equal(harness.calls.rerender, 1);
    assert.equal(harness.calls.refresh, 1);
});

test("authoritative server hydration refreshes the header before saving local state", () => {
    const hydrationStart = desktop.indexOf("function applyServerState(payload)");
    const hydration = desktop.slice(hydrationStart, hydrationStart + 8500);
    assert.ok(hydration.indexOf("appSessionStateLoaded = true") < hydration.indexOf("updateActiveCompanyUi()"));
    assert.ok(hydration.indexOf("updateActiveCompanyUi()") < hydration.indexOf("saveState({ includeCache: true })"));
});
