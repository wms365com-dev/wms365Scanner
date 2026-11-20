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
    assert.ok(bodyStart > 1, `${name} body must exist`);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${name} is incomplete`);
}

const isWarehouseSalesOrderDocumentOpen = Function(
    "ui",
    `"use strict"; ${extractFunction("isWarehouseSalesOrderDocumentOpen")}; return isWarehouseSalesOrderDocumentOpen;`
)({
    warehouseOrderEntryCard: {
        closest: () => ({ classList: { contains: (name) => name === "active" } }),
        classList: { contains: () => false }
    },
    warehouseOrderForm: { classList: { contains: () => false } }
});

test("visible mobile sales-order documents participate in dirty-state protection", () => {
    assert.equal(isWarehouseSalesOrderDocumentOpen(), true);

    const withHiddenCard = Function(
        "ui",
        `"use strict"; ${extractFunction("isWarehouseSalesOrderDocumentOpen")}; return isWarehouseSalesOrderDocumentOpen();`
    )({
        warehouseOrderEntryCard: {
            closest: () => ({ classList: { contains: (name) => name === "active" } }),
            classList: { contains: (name) => name === "hidden" }
        },
        warehouseOrderForm: { classList: { contains: () => false } }
    });
    assert.equal(withHiddenCard, false);

    const withLoadingForm = Function(
        "ui",
        `"use strict"; ${extractFunction("isWarehouseSalesOrderDocumentOpen")}; return isWarehouseSalesOrderDocumentOpen();`
    )({
        warehouseOrderEntryCard: {
            closest: () => ({ classList: { contains: (name) => name === "active" } }),
            classList: { contains: () => false }
        },
        warehouseOrderForm: { classList: { contains: (name) => name === "hidden" } }
    });
    assert.equal(withLoadingForm, false);

    const withInactivePanel = Function(
        "ui",
        `"use strict"; ${extractFunction("isWarehouseSalesOrderDocumentOpen")}; return isWarehouseSalesOrderDocumentOpen();`
    )({
        warehouseOrderEntryCard: {
            closest: () => ({ classList: { contains: () => false } }),
            classList: { contains: () => false }
        },
        warehouseOrderForm: { classList: { contains: () => false } }
    });
    assert.equal(withInactivePanel, false);
});

test("Escape, close, and new actions guard unsaved sales-order changes first", () => {
    const keydownStart = source.indexOf('window.addEventListener("keydown"');
    const keydownEnd = source.indexOf("mobileQuery.addEventListener", keydownStart);
    const keydown = source.slice(keydownStart, keydownEnd);
    assert.match(keydown, /event\.key === "Escape" && isWarehouseSalesOrderDocumentOpen\(\)/);
    assert.match(keydown, /closeSalesOrderDocument\(\{ scroll: false \}\)/);

    const close = extractFunction("closeSalesOrderDocument");
    assert.ok(close.indexOf("confirmDiscardWarehouseSalesOrderChanges()") < close.indexOf("window.history.back()"));
    assert.ok(close.indexOf("confirmDiscardWarehouseSalesOrderChanges()") < close.indexOf("showSalesOrderList"));

    const create = extractFunction("openNewSalesOrderDocument");
    assert.ok(create.indexOf("confirmDiscardWarehouseSalesOrderChanges()") < create.indexOf("showSalesOrderDocument"));
    assert.match(extractFunction("hasUnsavedWarehouseSalesOrderChanges"), /isWarehouseSalesOrderDocumentOpen\(\)/);

    for (const name of ["goBackMobileSection", "goBackDesktopSection"]) {
        const back = extractFunction(name);
        assert.ok(back.indexOf("confirmDiscardWarehouseSalesOrderChanges()") < back.indexOf("setSection(target"));
    }
    assert.ok(close.indexOf('warehouseSalesOrderFormBaseline = ""') < close.indexOf("window.history.back()"));
});

test("requested ship and delivery dates remain editable", () => {
    const shipDate = source.match(/<input id="warehouseOrderRequestedShipDate"[^>]*>/)?.[0] || "";
    const deliveryDate = source.match(/<input id="warehouseOrderRoutingDeliveryDate"[^>]*>/)?.[0] || "";
    for (const input of [shipDate, deliveryDate]) {
        assert.match(input, /type="date"/);
        assert.doesNotMatch(input, /\b(?:disabled|readonly)\b/);
    }
});

test("a new sales order can reset before any saved order exists", () => {
    const getPortalOrderShipToFields = Function(
        `"use strict"; ${extractFunction("getPortalOrderShipToFields")}; return getPortalOrderShipToFields;`
    )();
    assert.deepEqual(getPortalOrderShipToFields(null), {
        contactName: "",
        contactPhone: "",
        name: "",
        phone: "",
        address1: "",
        address2: "",
        city: "",
        state: "",
        postalCode: "",
        country: ""
    });
});

test("narrow and device-mobile document layouts keep date controls in one reachable column", () => {
    const narrowStart = source.indexOf("@media (max-width: 859px)");
    const narrowEnd = source.indexOf(".fold {", narrowStart);
    const narrow = source.slice(narrowStart, narrowEnd);
    assert.match(narrow, /\.erp-document-card \.form-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(narrow, /\.erp-document-card \.field,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(narrow, /\.erp-document-card input\[type="date"\][\s\S]*?min-width: 0;[\s\S]*?max-width: 100%/);

    assert.match(source, /body\.device-mobile \.erp-document-card \.form-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(source, /body\.device-mobile \.erp-document-card input\[type="date"\][\s\S]*?min-width: 0;[\s\S]*?max-width: 100%/);
});
