"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    applyCustomerFacingEmailPrivacy,
    isCustomerFacingEmail,
    normalizeSystemEmailMailOptions,
} = require("./server.js");

const CUSTOMER_SOURCE_TYPES = [
    "PORTAL_INBOUND",
    "PORTAL_INBOUND_OVERDUE",
    "PORTAL_ORDER_CONFIRMATION",
    "SPLIT_FULFILLMENT_NOTICE",
    "PORTAL_KITTING_STATUS",
    "SHIPMENT_CONFIRMATION",
    "PORTAL_ACCESS",
    "PORTAL_PASSWORD_RESET_LINK",
    "PORTAL_USERNAME_RECOVERY",
    "DELIVERY_APPOINTMENT_CUSTOMER",
    "SHOPIFY_DELIVERY",
    "invoice",
];

test("all recognized customer-facing emails are BCC-only behind the WMS365 system address", () => {
    for (const sourceType of CUSTOMER_SOURCE_TYPES) {
        const result = normalizeSystemEmailMailOptions({
            to: "customer-one@example.invalid, customer-two@example.invalid",
            cc: "customer-three@example.invalid",
            bcc: "customer-two@example.invalid",
            subject: sourceType,
            emailContext: { accountName: "TEST CUSTOMER", sourceType },
        });
        assert.equal(result.to, "support@wms365.co", sourceType);
        assert.equal(result.cc, "", sourceType);
        assert.deepEqual(result.bcc.split(", "), [
            "customer-one@example.invalid",
            "customer-two@example.invalid",
            "customer-three@example.invalid",
        ], sourceType);
        assert.equal(result.emailContext.audience, "CUSTOMER_BCC_ONLY", sourceType);
        assert.equal(result.metadata.addressingPolicy, "CUSTOMER_BCC_ONLY", sourceType);
    }
});

test("an already private customer envelope stays private and excludes the system address from BCC", () => {
    const result = applyCustomerFacingEmailPrivacy({
        to: "support@wms365.co",
        cc: "",
        bcc: "customer@example.invalid, support@wms365.co",
        emailContext: { sourceType: "PORTAL_KITTING_STATUS" },
    });
    assert.equal(result.to, "support@wms365.co");
    assert.equal(result.cc, "");
    assert.equal(result.bcc, "customer@example.invalid");
});

test("explicit customer audience is private even for a new source type", () => {
    const result = normalizeSystemEmailMailOptions({
        to: "customer@example.invalid",
        cc: "second@example.invalid",
        emailContext: { sourceType: "FUTURE_CUSTOMER_EVENT", audience: "CUSTOMER" },
    });
    assert.equal(result.to, "support@wms365.co");
    assert.equal(result.cc, "");
    assert.equal(result.bcc, "customer@example.invalid, second@example.invalid");
});

test("internal and operational email classes retain their requested envelope", () => {
    for (const sourceType of [
        "WAREHOUSE_PASSWORD_RECOVERY",
        "warehouse_billing_activity",
        "ORDER_ROUTING",
        "ORDER_ROUTING_READINESS",
        "DELIVERY_APPOINTMENT_REQUEST",
        "ADMIN_DAILY_SUMMARY",
        "SHIPMENT_DATA_QUALITY",
        "PORTAL_ORDER",
        "PORTAL_INBOUND_INTERNAL_AUDIT",
    ]) {
        const input = {
            to: "operations@example.invalid",
            cc: "manager@example.invalid",
            bcc: "audit@example.invalid",
            emailContext: { sourceType },
        };
        assert.equal(isCustomerFacingEmail(input), false, sourceType);
        const result = normalizeSystemEmailMailOptions(input);
        assert.equal(result.to, "operations@example.invalid", sourceType);
        assert.equal(result.cc, "manager@example.invalid", sourceType);
        assert.equal(result.bcc, "audit@example.invalid", sourceType);
    }
});

test("customer privacy classification is tenant-neutral", () => {
    for (const accountName of ["PURE FOODS BY ESTEE", "RANCHER'S CHIPS", "ANOTHER COMPANY"]) {
        const result = normalizeSystemEmailMailOptions({
            to: "customer@example.invalid",
            emailContext: { accountName, sourceType: "PORTAL_ORDER_CONFIRMATION" },
        });
        assert.equal(result.to, "support@wms365.co");
        assert.equal(result.bcc, "customer@example.invalid");
    }
});
