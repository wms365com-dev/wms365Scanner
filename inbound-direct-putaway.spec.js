const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
