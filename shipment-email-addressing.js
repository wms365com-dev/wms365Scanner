"use strict";

const PURE_FOODS_BCC_SHIPMENT_ORDER_CODES = new Set([
    "ORD-001029", "ORD-001030", "ORD-001032", "ORD-001226"
]);
const BCC_ONLY_SHIPMENT_ACCOUNTS = new Set([
    "ZETA GROUP (CANADA) LTD."
]);

function getPortalShipmentEmailAddressing(order, recipients = [], systemAddress = "") {
    const recipientList = recipients.join(", ");
    const accountName = String(order?.accountName || "").trim().toUpperCase();
    const orderCode = String(order?.orderCode || "").trim().toUpperCase();
    const usePrivateAddressing = BCC_ONLY_SHIPMENT_ACCOUNTS.has(accountName)
        || (accountName === "PURE FOODS BY ESTEE" && PURE_FOODS_BCC_SHIPMENT_ORDER_CODES.has(orderCode));
    if (usePrivateAddressing) {
        if (!systemAddress) throw new Error("A system recipient is required for BCC-only shipment email.");
        return { to: systemAddress, bcc: recipientList };
    }
    return { to: recipientList };
}

module.exports = { getPortalShipmentEmailAddressing };
