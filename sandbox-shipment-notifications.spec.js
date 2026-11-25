const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { isSandboxExternalSideEffectsDisabled, sendStoreShipmentConfirmationsForPortalOrder } = require("./server");

test("sandbox suppresses store shipment delivery before resolving the order", async (t) => {
    const key = "WMS365_SANDBOX_EXTERNAL_SIDE_EFFECTS_DISABLED";
    const original = process.env[key];
    t.after(() => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
    });
    process.env[key] = "true";
    const order = { get id() { throw new Error("Order should not be read"); } };
    assert.deepEqual(await sendStoreShipmentConfirmationsForPortalOrder(order), []);
    assert.equal(isSandboxExternalSideEffectsDisabled({ [key]: "false" }), false);
    assert.equal(isSandboxExternalSideEffectsDisabled({}), false);
});

test("shipment notification guards precede dispatch and sandbox state is skipped", () => {
    const source = readFileSync(join(__dirname, "server.js"), "utf8");
    for (const name of ["sendSystemEmail", "queueWarehouseBillingActivityEmail",
        "runDuePortalShipmentConfirmationEmails", "assertPortalShipmentEmailReady"]) {
        assert.match(source, new RegExp(`function ${name}\\([^\\n]*\\) \\{\\s+if \\(isSandboxExternalSideEffectsDisabled\\(\\)\\)`));
    }
    assert.match(source, /shipment_email_status = case when \$17::boolean then 'SKIPPED' else 'SCHEDULED' end/);
});
