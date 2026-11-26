const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { databaseSchemaContractIsCurrent, applyPendingAdditiveMigrations } = require("./server");

const ui = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("receiving defaults and pickable options use the exact company and warehouse", () => {
    const start = ui.indexOf("function getInboundReceivingStageLocation(");
    const end = ui.indexOf("function normalizeInboundPalletSizeType(", start);
    assert.ok(start >= 0 && end > start);
    const norm = (value) => String(value ?? "").trim().toUpperCase();
    const assignment = { accountName: "TEST", fulfillmentLocationId: "1", defaultReceivingBin: "DOCK", defaultPickableBin: "Z-BULK" };
    const bin = { accountName: "TEST", fulfillmentLocationId: "1", locationType: "STORAGE", isPickable: true };
    const state = { masters: { companyFulfillmentLocations: [assignment], locations: [
        { ...bin, code: "A-BULK" }, { ...bin, code: "Z-BULK" },
        { ...bin, code: "FOREIGN", accountName: "OTHER" },
        { ...bin, code: "OTHER-WAREHOUSE", fulfillmentLocationId: "2" },
        { ...bin, code: "HOLD", isPickable: false }
    ] } };
    const helpers = vm.runInNewContext(ui.slice(start, end) + "({getInboundReceivingStageLocation,getInboundDirectPutawayBins})", { state, norm });
    assert.equal(helpers.getInboundReceivingStageLocation(assignment), "DOCK");
    assert.equal(helpers.getInboundDirectPutawayBins(assignment).join(","), "Z-BULK,A-BULK");
    assert.equal(helpers.getInboundReceivingStageLocation({ ...assignment, fulfillmentLocationId: "2", fulfillmentLocationCode: "WH2" }), "WH2-REC");
});

test("posting direct putaway requires explicit confirmation and a locked compatible storage bin", () => {
    assert.match(ui, /receivingLocation: directBin, confirmDirectPutaway: true/);
    assert.match(server, /details\?\.confirmDirectPutaway === true/);
    assert.match(server, /confirmDirectPutaway \? "PUTAWAY_COMPLETE" : "RECEIVED_PENDING_PUTAWAY"/);
    assert.match(server, /where code = \$1 and account_name = \$2 and fulfillment_location_id = \$3\s+and is_pickable = true and location_type = 'STORAGE'\s+for update/);
});

test("receiving checks the actual allocation bins, not an unused shared fallback", async () => {
    const start = server.indexOf('    if (nextStatus === "RECEIVED") {', server.indexOf('let storedStatus = nextStatus;'));
    const prepare = 'await ensureReceivingDestinationLocation(client, line.receivedLocation);';
    const end = server.indexOf(prepare, start) + prepare.length;
    assert.ok(start >= 0 && end > start);
    const checked = [];
    const prepared = [];
    const receive = vm.runInNewContext(`(async () => {
        const nextStatus = "RECEIVED", details = { receivingLocation: "SHARED-REC" };
        const currentInbound = { accountName: "TEST" }, inboundId = 1;
        let storedStatus;
        ${server.slice(start, end)}
        }
        }
    })`, {
        client: { query: async () => {} },
        sanitizePortalInboundReceivingInput: () => [{ receivedLocation: destination }],
        assertWarehouseLocationIsolation: async (_client, { location }) => {
            checked.push(location);
            if (location === "SHARED-REC") throw new Error("Bin belongs to another company");
        },
        ensureReceivingDestinationLocation: async (_client, location) => prepared.push(location)
    });
    let destination = "TEST-BULK";
    await receive();
    assert.deepEqual(checked, ["TEST-BULK"]);
    assert.deepEqual(prepared, ["TEST-BULK"]);
    destination = "SHARED-REC";
    await assert.rejects(receive(), /another company/);
    assert.deepEqual(prepared, ["TEST-BULK"]);
});

test("warehouse receiving draft persists the selected bin without posting inventory", async () => {
    const start = server.indexOf("async function saveWarehouseReceivingDraft(");
    const end = server.indexOf("async function updateWarehousePortalInbound(", start);
    const save = vm.runInNewContext(server.slice(start, end) + "saveWarehouseReceivingDraft", {
        normalizeText: String,
        assertAppUserFulfillmentLocationAccess: async () => {},
        assertWarehouseLocationIsolation: async () => {},
        sanitizePortalInboundReceivingInput: (draft) => draft.receivingLines,
        getPortalInboundById: async () => ({ status: "ARRIVED" }),
        httpError: (_status, message) => new Error(message)
    });
    const writes = [];
    let conflict = false;
    const client = { query: async (sql, params) => {
        if (sql.includes("union all")) return { rowCount: conflict ? 1 : 0 };
        if (sql.startsWith("update")) writes.push([sql, JSON.parse(params[1])]);
        return { rowCount: 1 };
    } };
    const inbound = { accountName: "TEST", fulfillmentLocationId: 1 };
    const draft = { directBin: "TEST-BULK", receivingLines: [{ id: 1, receivedLocation: "TEST-BULK", receivedQuantity: 3 }] };
    assert.equal((await save(client, 1, "TEST", inbound, draft)).status, "ARRIVED");
    assert.match(writes[0][0], /^update portal_inbounds set receiving_draft/);
    assert.deepEqual(writes[0][1], draft);
    conflict = true;
    await assert.rejects(save(client, 1, "TEST", inbound, draft), /another company/);
    assert.equal(writes.length, 1);
    assert.match(ui, /bin === inbound\.receivingDraft\?\.directBin \? "selected"/);
});

test("rolling upgrade adds receiving defaults before an existing schema is ready", async () => {
    const binFields = new Set(["default_receiving_bin", "default_pickable_bin"]);
    const installed = new Set();
    const db = {
        async query(sql, params) {
            if (sql.startsWith("select to_regclass")) return { rows: [{ ready: true }] };
            if (sql.includes("from wms365_schema_versions")) return { rows: [{ current: false }] };
            if (sql.startsWith("with required_tables")) {
                const required = JSON.parse(params[1]).filter(([table, column]) =>
                    table === "company_fulfillment_locations" && binFields.has(column)
                );
                assert.equal(required.length, 2);
                return { rows: [{ tables_ready: true, columns_ready: required.every(([, column]) => installed.has(column)) }] };
            }
            if (sql.startsWith("alter table company_fulfillment_locations")) {
                for (const field of binFields) if (sql.includes("add column if not exists " + field)) installed.add(field);
            }
            return { rows: [] };
        }
    };
    assert.equal(await databaseSchemaContractIsCurrent(db), false);
    assert.equal(await applyPendingAdditiveMigrations(db), true);
    assert.equal(await databaseSchemaContractIsCurrent(db), true);
});
