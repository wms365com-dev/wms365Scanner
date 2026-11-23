const test = require("node:test");
const assert = require("node:assert/strict");
const { getPortalShipmentEmailAddressing } = require("./shipment-email-addressing");

const recipients = ["customer@example.com", "billing@example.com"];

test("four owner-requested Pure Foods shipment notices use BCC", () => {
    for (const orderCode of ["ORD-001029", "ORD-001030", "ORD-001032", "ORD-001226"]) {
        const addressing = getPortalShipmentEmailAddressing(
            { accountName: "PURE FOODS BY ESTEE", orderCode }, recipients, "support@wms365.co"
        );
        assert.equal(addressing.to, "support@wms365.co");
        assert.equal(addressing.bcc, recipients.join(", "));
        assert.ok(!addressing.to.includes("customer@example.com"));
    }
});

test("all Zeta shipment notices use private BCC addressing", () => {
    const addressing = getPortalShipmentEmailAddressing(
        { accountName: "ZETA GROUP (CANADA) LTD.", orderCode: "ORD-001281" },
        recipients,
        "support@wms365.co"
    );
    assert.deepEqual(addressing, {
        to: "support@wms365.co",
        bcc: recipients.join(", ")
    });
});

test("other orders and tenants retain normal shipment addressing", () => {
    for (const order of [
        { accountName: "PURE FOODS BY ESTEE", orderCode: "ORD-001227" },
        { accountName: "ZETA GROUP USA", orderCode: "ORD-001281" },
        { accountName: "OTHER COMPANY", orderCode: "ORD-001030" }
    ]) {
        assert.deepEqual(getPortalShipmentEmailAddressing(order, recipients, "support@wms365.co"), {
            to: recipients.join(", ")
        });
    }
});
