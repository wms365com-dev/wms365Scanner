"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SHOPIFY_APP_SCOPES,
  renderIntegrationCredentialRequestPage,
  testSubmittedShopifyCredential,
  normalizeSecureShopifyConfiguration
} = require("./server");

const request = {
  accountName: "NOMMM CANADA INC.",
  provider: "SHOPIFY",
  integrationName: "NOMMM Shopify",
  storeIdentifier: "",
  expiresAt: "2026-11-08T12:00:00.000Z",
  syncSchedule: "MANUAL",
  importStatus: "DRAFT",
  settings: {}
};

test("NOMMM secure handoff is fully self-service and submit starts locked", () => {
  const html = renderIntegrationCredentialRequestPage({ token: "preview-token", request });
  for (const expected of [
    "Permanent Shopify domain",
    "Shopify Admin API access token",
    "Test connection",
    'id="submit-button" type="submit" disabled',
    'name="syncOrders"',
    'name="syncInventory"',
    'name="syncShipmentConfirmations"',
    'name="notifyCustomerOnFulfillment"',
    'name="shopifyLocationId"',
    'name="syncSchedule"',
    'name="importStatus"',
    'name="allowedShipCountries"'
  ]) assert.match(html, new RegExp(expected));
});

test("connection test verifies exact store, permissions, and active locations", async () => {
  const scopes = String(SHOPIFY_APP_SCOPES).split(",").map((scope) => scope.trim()).filter(Boolean);
  const result = await testSubmittedShopifyCredential(request, "shpat_example_token_123456789", {
    shopDomain: "nommm-test.myshopify.com",
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        shop: { name: "NOMMM Test", myshopifyDomain: "nommm-test.myshopify.com" },
        currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
        locations: { nodes: [{ id: "gid://shopify/Location/12345", legacyResourceId: "12345", name: "Grey Wolf Fulfillment", isActive: true }] }
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });
  assert.equal(result.shopDomain, "nommm-test.myshopify.com");
  assert.deepEqual(result.locations, [{ id: "12345", name: "Grey Wolf Fulfillment", active: true }]);
});

test("stock sync requires a location returned by Shopify", () => {
  assert.throws(() => normalizeSecureShopifyConfiguration({
    syncInventory: "on",
    shopifyLocationId: "unverified"
  }, request, { locations: [] }), /verified Shopify location/);
});

test("reviewed self-service settings are normalized for persistence", () => {
  const result = normalizeSecureShopifyConfiguration({
    syncOrders: "on",
    syncInventory: "on",
    syncShipmentConfirmations: "on",
    notifyCustomerOnFulfillment: "on",
    shopifyLocationId: "12345",
    syncSchedule: "EVERY_15_MINUTES",
    importStatus: "DRAFT",
    allowedShipCountries: "CA,US"
  }, request, { locations: [{ id: "12345", name: "Grey Wolf Fulfillment", active: true }] });
  assert.equal(result.syncSchedule, "EVERY_15_MINUTES");
  assert.equal(result.importStatus, "DRAFT");
  assert.equal(result.settings.syncOrders, true);
  assert.equal(result.settings.syncInventory, true);
  assert.equal(result.settings.syncShipmentConfirmations, true);
  assert.equal(result.settings.shopifyLocationId, "12345");
  assert.deepEqual(result.settings.allowedShipCountries, ["CA", "US"]);
});
