const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function functionBody(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = source.indexOf("\n        function ", start + 1);
    const nextAsync = source.indexOf("\n        async function ", start + 1);
    const endCandidates = [next, nextAsync].filter((value) => value > start);
    return source.slice(start, Math.min(...endCandidates));
}

test("single-order print reserves its popup before the detail request", () => {
    const body = functionBody("printCurrentWarehouseSalesOrderDocument");
    const reserveIndex = body.indexOf("reservePortalOrderPrintWindow");
    const requestIndex = body.indexOf("await requestPortalOrderDetail");
    assert.ok(reserveIndex >= 0 && requestIndex > reserveIndex);
    assert.match(body, /printPortalOrderDocument\([\s\S]*?printWindow\)/);
});

test("list pick-ticket and packing-slip actions reuse a synchronously reserved popup", () => {
    assert.match(source, /const pickTicketButton[\s\S]*?const printWindow = reservePortalOrderPrintWindow\(actionMessageElement\);[\s\S]*?await requestPortalOrderDetail[\s\S]*?printPortalOrderDocument\(order, "pick", actionMessageElement, printWindow\)/);
    assert.match(source, /const packingSlipButton[\s\S]*?const printWindow = reservePortalOrderPrintWindow\(actionMessageElement\);[\s\S]*?await requestPortalOrderDetail[\s\S]*?printPortalOrderDocument\(order, "packing", actionMessageElement, printWindow\)/);
});

test("reserved windows close on reprint cancellation and request failure", () => {
    assert.match(source, /if \(!confirmed\) \{\s*closeReservedPrintWindow\(reservedPrintWindow\);/);
    const currentBody = functionBody("printCurrentWarehouseSalesOrderDocument");
    assert.match(currentBody, /catch \(error\) \{\s*closeReservedPrintWindow\(printWindow\);/);
    assert.match(source, /function closeReservedPrintWindow\(printWindow\)[\s\S]*?printWindow\.close\(\)/);
});
