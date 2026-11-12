const fs = require("fs");
const Module = require("module");
const path = require("path");
const { Pool } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";

function loadProductionApi() {
    const filename = require.resolve("../server");
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(fs.readFileSync(filename, "utf8") + `
module.exports.__ranchersPull = {
  fetchShopifyOrdersForIntegration,
  importStoreOrdersForIntegration,
  decryptStoreIntegrationRow
};`, filename);
    return mod.exports.__ranchersPull;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is unavailable");
    const api = loadProductionApi();
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const scope = await pool.query(
            `select * from store_integrations
             where id = 4 and account_name = $1 and provider = 'SHOPIFY'
               and lower(store_identifier) = $2 and is_active = true`,
            [ACCOUNT, STORE]
        );
        if (scope.rowCount !== 1) throw new Error("Rancher's integration scope mismatch");
        const warehouse = await pool.query(
            "select id, code from fulfillment_locations where id = 1 and code = 'GW3PL-MISS'"
        );
        if (warehouse.rowCount !== 1) throw new Error("Rancher's warehouse scope mismatch");
        const integration = api.decryptStoreIntegrationRow(scope.rows[0]);
        const orders = await api.fetchShopifyOrdersForIntegration(integration);
        const client = await pool.connect();
        let summary;
        try {
            await client.query("begin");
            summary = await api.importStoreOrdersForIntegration(client, integration, orders, null);
            await client.query("commit");
        } catch (error) {
            await client.query("rollback");
            throw error;
        } finally {
            client.release();
        }
        console.log(JSON.stringify({
            scope: { account: ACCOUNT, integrationId: 4, store: STORE, warehouse: "GW3PL-MISS", warehouseId: 1 },
            ordersFetched: orders.length,
            importedCount: Number(summary.importedCount) || 0,
            releasedCount: Number(summary.releasedCount) || 0,
            draftCount: Number(summary.draftCount) || 0,
            skippedCount: Number(summary.skippedCount) || 0,
            failedCount: Number(summary.failedCount) || 0,
            message: summary.message || ""
        }));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ error: error.message || String(error) }));
    process.exitCode = 1;
});
