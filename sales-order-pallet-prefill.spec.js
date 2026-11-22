const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function extractFunction(name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${name} must exist`);
    const bodyStart = source.indexOf(") {", start) + 2;
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${name} is incomplete`);
}

const resolveShipmentPalletDefaults = Function(
    `"use strict"; ${extractFunction("resolveShipmentPalletDefaults")}; return resolveShipmentPalletDefaults;`
)();

test("staged pallet totals prefill as existing pallets when no pallet source is recorded", () => {
    assert.deepEqual(resolveShipmentPalletDefaults({ totalPalletsOut: 3 }), {
        totalPalletsOut: 3,
        existingPalletsOut: 3,
        newPalletsUsed: 0,
        mixedPalletsBuilt: 0,
        palletNote: ""
    });
});

test("explicit existing and new pallet counts are preserved", () => {
    assert.deepEqual(resolveShipmentPalletDefaults({
        totalPalletsOut: 4,
        existingPalletsOut: 2,
        newPalletsUsed: 2,
        mixedPalletsBuilt: 1,
        palletNote: "One mixed pallet"
    }), {
        totalPalletsOut: 4,
        existingPalletsOut: 2,
        newPalletsUsed: 2,
        mixedPalletsBuilt: 1,
        palletNote: "One mixed pallet"
    });
});

test("a recorded new-pallet count never becomes existing stock", () => {
    assert.equal(resolveShipmentPalletDefaults({
        totalPalletsOut: 2,
        existingPalletsOut: 0,
        newPalletsUsed: 2
    }).existingPalletsOut, 0);
});

test("the shipping form uses resolved defaults while server validation remains authoritative", () => {
    assert.match(source, /const outboundPallets = resolveShipmentPalletDefaults\(order\.outboundPallets\)/);
    assert.match(source, /Existing pallets plus new pallets must equal total pallets out\./);
});
