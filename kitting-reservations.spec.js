const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { sanitizePortalKittingComponents } = require("./server.js");

function functionSource(source, name, nextName) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start + 1);
    assert.notEqual(start, -1, `${name} was not found`);
    return source.slice(start, end === -1 ? source.length : end);
}

test("explicit total batch quantity is not multiplied by finished quantity", () => {
    const components = sanitizePortalKittingComponents({
        components: [{ sku: "SOURCE-A", quantityPerUnit: 4, totalQuantity: 4 }]
    }, 96);
    assert.equal(components[0].totalQuantity, 4);
});

test("legacy per-finished quantity remains supported when total is omitted", () => {
    const components = sanitizePortalKittingComponents({
        components: [{ sku: "SOURCE-A", quantityPerUnit: 2 }]
    }, 12);
    assert.equal(components[0].totalQuantity, 24);
});

test("customer portal labels component input as total batch quantity", () => {
    const portal = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
    assert.match(portal, /Total Batch Qty/);
    assert.match(portal, /Submitted quantities are reserved immediately/);
    assert.doesNotMatch(portal, /Enter the quantity needed per finished display/);
});

test("inventory commitments include active kitting allocations", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(server, /portal_kitting_allocations/);
    assert.match(server, /reserved for kitting/);
    assert.match(server, /completePortalKittingInventory/);
    assert.match(server, /delete from portal_kitting_allocations where kitting_request_id/);
});

test("completion detects a reserved inventory line that no longer exists", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(server, /left join inventory_lines i on i\.id = a\.inventory_line_id/);
    assert.match(server, /inventory_line_missing/);
    assert.match(server, /Reserved stock for \$\{missingAllocation\.sku\} is no longer available/);
});

test("kitting emails describe the automated reservation workflow", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const emailHtml = functionSource(server, "buildPortalKittingRequestEmailHtml", "sendPortalKittingRequestEmail");
    assert.match(emailHtml, /Total Batch Qty Reserved/);
    assert.match(emailHtml, /WMS365 will post all component deductions and finished inventory together/);
    assert.doesNotMatch(emailHtml, /Qty \/ Display/);
    assert.doesNotMatch(emailHtml, /Convert Item/);
});

test("kitting emails protect recipients and notify the request creator", () => {
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const requestEmail = functionSource(server, "sendPortalKittingRequestEmail", "queuePortalKittingRequestEmail");
    const statusEmail = functionSource(server, "sendPortalKittingRequestStatusEmail", "queuePortalKittingRequestStatusEmail");
    assert.match(statusEmail, /request\.requestedByEmail/);
    assert.match(statusEmail, /to: WMS365_SYSTEM_EMAIL_ADDRESS,[\s\S]*?bcc: recipients\.join/);
    assert.match(requestEmail, /to: WMS365_SYSTEM_EMAIL_ADDRESS,[\s\S]*?bcc: recipients\.join/);
});
