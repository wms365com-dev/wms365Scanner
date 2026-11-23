const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const server = read("server.js");
const home = read("warehouse-actions.html");
const receive = read("mobile-receive.html");
const ship = read("mobile-pick.html");

test("warehouse action pages require the authenticated warehouse session", () => {
    assert.match(server, /sendAuthenticatedWarehouseModule/);
    assert.match(server, /\["\/warehouse-actions", "\/warehouse-actions\.html"\]/);
    assert.match(server, /\["\/mobile-receive", "\/mobile-receive\.html"\]/);
    assert.match(server, /await requireAppSession\(req\)/);
});
test("company selection is carried into company-scoped receive and ship requests", () => {
    assert.match(home, /mobile-receive\?accountName=/);
    assert.match(home, /mobile-pick\?mode=ship&accountName=/);
    assert.match(receive, /portal-inbounds\?accountName=/);
    assert.match(receive, /\['SUBMITTED','ARRIVED'\]/);
    assert.match(ship, /requestedMode\(\)==='SHIP'\?\['STAGED'\]/);
});

test("receiving only submits lines displayed from the selected inbound", () => {
    assert.match(receive, /selected\.lines\[Number\(card\.dataset\.lineIndex\)\]/);
    assert.match(receive, /receivingLines/);
    assert.match(receive, /status:'RECEIVED'/);
    assert.match(receive, /Pallet count for/);
    assert.doesNotMatch(receive, /api\/admin\/portal-inbounds",\{method:'POST'/);
});

test("shipping-only mode keeps the established proof and short-ship controls", () => {
    assert.match(ship, /SHIPMENT_BOL/);
    assert.match(ship, /SHIPMENT_PACKING_SLIP/);
    assert.match(ship, /SHIPMENT_LOAD_PHOTO/);
    assert.match(ship, /shortShipped/);
    assert.match(ship, /packingSlipQuantityConfirmed:true/);
});
