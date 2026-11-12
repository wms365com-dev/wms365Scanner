"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const INTEGRATION_ID = 4;
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";

function businessApi() {
  const filename = require.resolve("../server");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = fs.readFileSync(filename, "utf8") + `
module.exports.runRanchersOrderImportOnly = async function () {
  const integration = await getStoreIntegrationRowById(pool, ${INTEGRATION_ID});
  if (!integration || integration.account_name !== ${JSON.stringify(ACCOUNT)}
      || integration.provider !== "SHOPIFY"
      || integration.store_identifier !== ${JSON.stringify(STORE)}
      || integration.is_active !== true) {
    throw new Error("Rancher's Shopify integration identity mismatch.");
  }
  const warehouse = await pool.query(
    "select id, code from fulfillment_locations where id = $1 and code = $2",
    [${WAREHOUSE_ID}, ${JSON.stringify(WAREHOUSE_CODE)}]
  );
  if (warehouse.rowCount !== 1) throw new Error("Rancher's warehouse identity mismatch.");
  const claim = await claimStoreIntegrationSync(pool, ${INTEGRATION_ID}, { scheduled: false });
  if (!claim) throw new Error("Rancher's Shopify integration is already syncing.");
  try {
    const decrypted = decryptStoreIntegrationRow(claim.row);
    const orders = await fetchShopifyOrdersForIntegration(decrypted);
    const summary = await withTransaction((client) =>
      importStoreOrdersForIntegration(client, decrypted, orders, null)
    );
    return { ...summary, ordersFetched: orders.length };
  } finally {
    await releaseStoreIntegrationSyncClaim(pool, ${INTEGRATION_ID}, claim.token);
  }
};`;
  mod._compile(source, filename);
  return mod.exports;
}

async function main() {
  const result = await businessApi().runRanchersOrderImportOnly();
  console.log(JSON.stringify({
    state: "ORDER_IMPORT_COMPLETE",
    ordersFetched: Number(result.ordersFetched) || 0,
    importedCount: Number(result.importedCount) || 0,
    releasedCount: Number(result.releasedCount) || 0,
    draftCount: Number(result.draftCount) || 0,
    skippedCount: Number(result.skippedCount) || 0,
    failedCount: Number(result.failedCount) || 0,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
