const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { saveBulkInventoryWorksheet } = require("./server");

const savedRow = {
    id: 1, account_name: "TEST", location: "LEGACY-BIN", sku: "TEST-SKU", quantity: 3,
    created_at: "2026-11-24T00:00:00Z", updated_at: "2026-11-24T00:00:00Z"
};
const input = { id: 1, location: "LEGACY-BIN", sku: "TEST-SKU", quantity: 3 };

function mockClient() {
    let reads = 0;
    return {
        async query(sql, params) {
            assert.equal(++reads, 1, "only the initial scoped inventory read is expected");
            assert.match(sql, /where account_name = \$1/);
            assert.deepEqual(params, ["TEST"]);
            return { rows: [savedRow] };
        }
    };
}

test("unchanged legacy worksheet rows are not revalidated or rewritten", async () => {
    assert.deepEqual(await saveBulkInventoryWorksheet(mockClient(), "TEST", [input]), {
        processed: 0, added: 0, updated: 0, deleted: 0
    });
});

test("worksheet still rejects a row ID absent from the selected company", async () => {
    await assert.rejects(saveBulkInventoryWorksheet(mockClient(), "TEST", [{ ...input, id: 2 }]),
        /no longer matches a saved inventory line/);
});

const warehouseUi = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("worksheet captures edits as a company-bound draft before redraw", () => {
    const start = warehouseUi.indexOf("function onInventoryWorksheetTableChange(");
    const end = warehouseUi.indexOf("function renderSummary(", start);
    const rows = [{ sku: "TEST-A", quantity: 4 }, { sku: "TEST-B", quantity: 7 }];
    const context = {
        getActiveCompany: () => "TEST",
        collectInventoryWorksheetRows: (options) => {
            assert.equal(options.includeBlankRows, true);
            return rows;
        },
        inventoryWorksheetDraftCompany: "",
        inventoryWorksheetDraftRows: null,
        event: { target: { closest: () => ({ dataset: { worksheetField: "quantity" } }) } }
    };
    vm.runInNewContext(warehouseUi.slice(start, end) + "onInventoryWorksheetTableChange(event);", context);
    assert.equal(context.inventoryWorksheetDraftCompany, "TEST");
    assert.equal(context.inventoryWorksheetDraftRows, rows);
    assert.match(warehouseUi, /addEventListener\("input", onInventoryWorksheetTableChange\)/);
});

test("adjust and convert location suggestions use the resolved company", () => {
    for (const [account, mode] of [["adjustAccount", "source"], ["convertAccount", "source"], ["convertAccount", "destination"]]) {
        assert.ok(warehouseUi.includes(
            `getOwnerScopedLocationSuggestions(query, getScopedCompanyValue(ui.${account}.value), { mode: "${mode}" })`
        ));
    }
});
