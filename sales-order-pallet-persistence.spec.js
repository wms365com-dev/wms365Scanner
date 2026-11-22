const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const verifier = fs.readFileSync(path.join(__dirname, "scripts", "verify-test-company-sales-order-pallet-persistence.js"), "utf8");
const { sanitizePortalOrderInput } = require("./server");

test("sales-order draft payload includes the entered pallet total", () => {
    const start = desktop.indexOf("function collectWarehouseSalesOrderPayload");
    const end = desktop.indexOf("function serializeWarehouseSalesOrderForm", start);
    const collect = desktop.slice(start, end);
    assert.match(collect, /outboundPallets:\s*\{[\s\S]*?totalPalletsOut:\s*Number\.parseInt\(ui\.warehouseOrderRoutingPallets\.value/);
});

test("draft sanitizer keeps LTL pallet totals and rejects them for parcel orders", () => {
    const ltl = sanitizePortalOrderInput({
        shipmentMethod: "LTL_FREIGHT",
        outboundPallets: { totalPalletsOut: 5 },
        lines: []
    }, "CODEX PORTAL SYSTEM TEST");
    assert.equal(ltl.outboundPallets.totalPalletsOut, 5);

    const parcel = sanitizePortalOrderInput({
        shipmentMethod: "PARCEL",
        outboundPallets: { totalPalletsOut: 5 },
        lines: []
    }, "CODEX PORTAL SYSTEM TEST");
    assert.equal(parcel.outboundPallets.totalPalletsOut, 0);
});

test("draft insert and update persist only the normalized pallet total", () => {
    const start = server.indexOf("async function savePortalOrderDraftForAccount");
    const end = server.indexOf("async function savePortalOrderDraft(", start + 1);
    const saveDraft = server.slice(start, end);
    assert.match(saveDraft, /outbound_total_pallets = \$42/);
    assert.match(saveDraft, /routing_requested_delivery_date,[\s\S]*?outbound_total_pallets,[\s\S]*?values[\s\S]*?\$42/);
    assert.match(saveDraft, /order\.outboundPallets\.totalPalletsOut/g);
    assert.doesNotMatch(saveDraft, /outbound_existing_pallets\s*=|outbound_new_pallets\s*=|outbound_mixed_pallets\s*=/);
});

test("sandbox persistence verifier is designated-company pinned and rollback-only", () => {
    assert.match(verifier, /requireDesignatedTestCompany\(client\)/);
    assert.match(verifier, /savePortalOrderDraftForAccount/);
    assert.match(verifier, /getPortalOrderById/);
    assert.match(verifier, /outboundPallets\.totalPalletsOut !== 5/);
    assert.match(verifier, /outboundPallets\.totalPalletsOut !== 7/);
    assert.match(verifier, /outboundPallets\.totalPalletsOut !== 0/);
    assert.match(verifier, /await client\.query\("rollback"\)/);
    assert.doesNotMatch(verifier, /commit|production|sendSystemEmail/i);
});
