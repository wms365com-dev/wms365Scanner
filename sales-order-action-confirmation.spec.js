const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function functionBody(name, nextName) {
    const start = desktop.indexOf(`function ${name}`);
    const asyncStart = desktop.indexOf(`async function ${name}`);
    const actualStart = asyncStart >= 0 && (start < 0 || asyncStart < start) ? asyncStart : start;
    const end = desktop.indexOf(`function ${nextName}`, actualStart + 1);
    assert.notEqual(actualStart, -1, `${name} must exist`);
    assert.notEqual(end, -1, `${nextName} boundary must exist`);
    return desktop.slice(actualStart, end);
}

test("warehouse confirmation uses an accessible in-app modal with confirm, cancel, and Escape paths", () => {
    const confirmAction = functionBody("confirmWarehouseAction", "saveWarehouseSalesOrderDraft");
    assert.match(confirmAction, /role=\"dialog\" aria-modal=\"true\"/);
    assert.match(confirmAction, /data-action-confirm-accept/);
    assert.match(confirmAction, /data-action-confirm-cancel/);
    assert.match(confirmAction, /event\.key === "Escape"/);
    assert.match(confirmAction, /resolve\(confirmed\)/);
});

test("duplicate, cancel, and archive await the in-app confirmation before changing an order", () => {
    const duplicate = functionBody("duplicateWarehouseSalesOrder", "createWarehouseSalesOrderReturnInbound");
    const cancel = functionBody("deleteWarehouseSalesOrder", "archiveWarehouseSalesOrderDraft");
    const archive = functionBody("archiveWarehouseSalesOrderDraft", "getWarehouseInboundCompany");
    for (const action of [duplicate, cancel, archive]) {
        assert.match(action, /await confirmWarehouseAction/);
        assert.doesNotMatch(action, /window\.confirm/);
    }
    assert.match(duplicate, /confirmLabel: "Create Draft"/);
    assert.match(cancel, /confirmLabel: "Cancel Order"/);
    assert.match(archive, /confirmLabel: "Archive Draft"/);
});

test("shipment closeout awaits the visible quantity confirmation before submitting SHIPPED", () => {
    const review = functionBody("confirmPortalShipmentCloseoutReview", "updatePortalShipmentMethodPanel");
    assert.match(review, /confirmWarehouseAction/);
    assert.match(review, /Confirm and Mark Shipped/);
    assert.doesNotMatch(review, /window\.confirm/);
    assert.match(desktop, /packingSlipQuantityConfirmed = await confirmPortalShipmentCloseoutReview/);
});
