const test = require("node:test");
const assert = require("node:assert/strict");

const {
    filterInventoryRowsForFulfillmentLocationIds,
    filterLocationMasterRowsForAppUser,
    sanitizeInventoryMoveImages
} = require("./server");

const warehouses = [
    { id: 10, code: "GW3PL-MISS" },
    { id: 20, code: "GW3PL-EDW" }
];
const assignments = [
    { account_name: "TEST COMPANY", fulfillment_location_id: 10 },
    { account_name: "TEST COMPANY", fulfillment_location_id: 20 }
];

test("Edwards-scoped state excludes the same company's Main warehouse stock", () => {
    const rows = [
        { account_name: "TEST COMPANY", location: "GW3PL-MISS-A01", sku: "MAIN-SKU" },
        { account_name: "TEST COMPANY", location: "GW3PL-EDW-A01", sku: "EDW-SKU" }
    ];

    const visible = filterInventoryRowsForFulfillmentLocationIds(rows, assignments, warehouses, [20]);
    assert.deepEqual(visible.map((row) => row.sku), ["EDW-SKU"]);
});

test("Edwards-scoped state excludes another customer's locations", () => {
    const inventory = [{ account_name: "TEST COMPANY", location: "GW3PL-EDW-A01" }];
    const locations = [
        { code: "GW3PL-EDW-A01", account_name: "TEST COMPANY", fulfillment_location_id: 20 },
        { code: "GW3PL-EDW-B01", account_name: "OTHER COMPANY", fulfillment_location_id: 20 },
        { code: "GW3PL-MISS-A01", account_name: "TEST COMPANY", fulfillment_location_id: 10 }
    ];

    const visible = filterLocationMasterRowsForAppUser(locations, inventory, warehouses, [20], ["TEST COMPANY"]);
    assert.deepEqual(visible.map((row) => row.code), ["GW3PL-EDW-A01"]);
});

function image(name = "proof.png", type = "image/png") {
    const bytes = type === "image/jpeg"
        ? Buffer.from([0xff, 0xd8, 0xff, 0xd9])
        : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return {
        fileName: name,
        fileType: type,
        dataUrl: `data:${type};base64,${bytes.toString("base64")}`
    };
}

test("QC move accepts at most five supported images", () => {
    const accepted = sanitizeInventoryMoveImages(Array.from({ length: 5 }, (_, index) => image(`proof-${index + 1}.png`)));
    assert.equal(accepted.length, 5);
    assert.throws(
        () => sanitizeInventoryMoveImages(Array.from({ length: 6 }, (_, index) => image(`proof-${index + 1}.png`))),
        /up to 5/i
    );
    assert.throws(
        () => sanitizeInventoryMoveImages([{ fileName: "proof.pdf", fileType: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0=" }]),
        /JPEG, PNG, or WebP/i
    );
});
