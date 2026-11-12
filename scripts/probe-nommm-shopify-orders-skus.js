"use strict";

const fs = require("fs");
const Module = require("module");
const path = require("path");
const { Pool } = require("pg");

const ACCOUNT = "NOMMM CANADA INC.";
const STORE = "fresh-canvas-studio-74lsu.myshopify.com";
const INTEGRATION_ID = 6;
const APPLY_ORDERS = process.argv.includes("--apply-orders");

function loadApi() {
  const filename = require.resolve("../server");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, "utf8") + `
module.exports.__nommmProbe = {
  decryptStoreIntegrationRow,
  fetchShopifyOrdersForIntegration,
  fetchShopifyVariantInventoryItemsForIntegration,
  importStoreOrdersForIntegration
};`, filename);
  return mod.exports.__nommmProbe;
}

async function main() {
  const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection is unavailable.");
  const api = loadApi();
  const pool = new Pool({ connectionString, ssl: false });
  try {
    const scope = await pool.query(
      `select * from store_integrations
        where id=$1 and account_name=$2 and provider='SHOPIFY'
          and lower(store_identifier)=$3 and is_active=true`,
      [INTEGRATION_ID, ACCOUNT, STORE]
    );
    if (scope.rowCount !== 1) throw new Error("Exact active NOMMM Shopify integration scope failed.");
    const integration = api.decryptStoreIntegrationRow(scope.rows[0]);
    const settings = integration.settings || {};
    if (settings.syncOrders !== true) throw new Error("NOMMM order sync is not enabled.");
    if (settings.syncInventory === true) throw new Error("NOMMM stock sync must remain disabled for this controlled test.");
    if (settings.syncShipmentConfirmations === true || settings.notifyCustomerOnFulfillment === true) {
      throw new Error("NOMMM fulfillment or buyer notifications must remain disabled for this controlled test.");
    }

    const [orders, variantResult] = await Promise.all([
      api.fetchShopifyOrdersForIntegration(integration),
      api.fetchShopifyVariantInventoryItemsForIntegration(integration)
    ]);
    const orderSummary = orders.map((order) => ({
      shopifyOrder: String(order.name || order.order_number || order.id || ""),
      shipCountry: String(order.shipping_address?.country_code || order.shipping_address?.country || ""),
      financialStatus: String(order.financial_status || ""),
      fulfillmentStatus: String(order.fulfillment_status || ""),
      skus: [...new Set((order.line_items || []).map((line) => String(line.sku || "").trim()).filter(Boolean))]
    }));
    const skuSummary = variantResult.variants.map((variant) => ({
      sku: variant.sku,
      inventoryManagedBy: variant.inventoryManagement,
      inventoryPolicy: variant.inventoryPolicy
    }));

    let importSummary = null;
    if (APPLY_ORDERS) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        importSummary = await api.importStoreOrdersForIntegration(client, integration, orders, null);
        const imported = await client.query(
          `select o.order_code,o.status,s.external_order_id
             from store_order_imports s join portal_orders o on o.id=s.portal_order_id
            where s.integration_id=$1 order by s.id desc limit 100`,
          [INTEGRATION_ID]
        );
        const nonDraft = imported.rows.filter((row) => row.status !== "DRAFT");
        if (nonDraft.length) throw new Error(`Controlled NOMMM import created non-draft orders: ${nonDraft.map((row) => row.order_code).join(", ")}`);
        await client.query("commit");
        importSummary.importedOrders = imported.rows;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(JSON.stringify({
      scope: { account: ACCOUNT, integrationId: INTEGRATION_ID, store: STORE },
      controls: {
        ordersEnabled: settings.syncOrders === true,
        stockSyncEnabled: settings.syncInventory === true,
        shipmentSyncEnabled: settings.syncShipmentConfirmations === true,
        buyerNotificationsEnabled: settings.notifyCustomerOnFulfillment === true,
        allowedShipCountries: settings.allowedShipCountries || [],
        schedule: integration.sync_schedule || ""
      },
      openOrdersFetched: orders.length,
      orders: orderSummary,
      skuCount: skuSummary.length,
      skus: skuSummary,
      importSummary
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
