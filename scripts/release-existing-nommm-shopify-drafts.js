"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { Pool } = require("pg");

const ACCOUNT = "NOMMM CANADA INC.";
const INTEGRATION_ID = 6;
const APPLY = process.argv.includes("--apply");
const GIFT_SKU = "NOMMM-FOUNDER-GIFT-3PK";
const GIFT_COMPONENTS = ["NN95034", "NN95035", "NN95033"];

function loadApi() {
    const filename = require.resolve("../server");
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(fs.readFileSync(filename, "utf8") + `
module.exports.__nommmRelease = {
  getPortalOrderById,
  saveWarehousePortalOrderDraft,
  releaseWarehousePortalOrder,
  queuePortalOrderReleaseEmail,
  queuePortalOrderConfirmationEmail,
  queuePortalOrderSplitFulfillmentNotice
};`, filename);
    return mod.exports.__nommmRelease;
}

function planHash(orderIds) {
    return crypto.createHash("sha256").update(JSON.stringify({
        account: ACCOUNT,
        integrationId: INTEGRATION_ID,
        orderIds
    })).digest("hex").slice(0, 24);
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection unavailable.");
    const api = loadApi();
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    const releasedOrders = [];
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`nommm-shopify-draft-release:${INTEGRATION_ID}`]);
        const drafts = await client.query(
            `select o.id,o.order_code
               from store_order_imports i
               join portal_orders o on o.id=i.portal_order_id
              where i.integration_id=$1 and o.account_name=$2 and o.status='DRAFT'
              order by i.id
              for update of o`,
            [INTEGRATION_ID, ACCOUNT]
        );
        const ids = drafts.rows.map((row) => String(row.id));
        const hash = planHash(ids);
        if (APPLY && String(process.env.NOMMM_DRAFT_RELEASE_PLAN_HASH || "") !== hash) {
            throw new Error(`Refusing apply without NOMMM_DRAFT_RELEASE_PLAN_HASH=${hash}.`);
        }
        const eligible = [];
        const blocked = [];
        for (const draft of drafts.rows) {
            await client.query("savepoint nommm_release_order");
            try {
                const current = await api.getPortalOrderById(client, draft.id, ACCOUNT);
                if (!current || !Array.isArray(current.lines) || !current.lines.length
                    || current.lines.some((line) => line.sku !== GIFT_SKU || !(Number(line.quantity) > 0))) {
                    throw new Error("Draft lines do not match the reviewed founder-gift parent SKU.");
                }
                const giftQuantity = current.lines.reduce((sum, line) => sum + Number(line.quantity), 0);
                await api.saveWarehousePortalOrderDraft(client, ACCOUNT, {
                    ...current,
                    lines: GIFT_COMPONENTS.map((sku) => ({ sku, quantity: giftQuantity * 2 }))
                }, draft.id, { full_name: "NomNom Shopify auto-release" });
                const released = await api.releaseWarehousePortalOrder(client, draft.id, {
                    full_name: "NomNom Shopify auto-release"
                });
                eligible.push(draft.order_code);
                if (APPLY) {
                    releasedOrders.push(released);
                    await client.query("release savepoint nommm_release_order");
                } else {
                    await client.query("rollback to savepoint nommm_release_order");
                    await client.query("release savepoint nommm_release_order");
                }
            } catch (error) {
                await client.query("rollback to savepoint nommm_release_order");
                await client.query("release savepoint nommm_release_order");
                blocked.push({ orderCode: draft.order_code, reason: String(error.message || error) });
            }
        }
        if (APPLY) await client.query("commit");
        else await client.query("rollback");

        if (APPLY) {
            for (const order of releasedOrders) {
                const context = { actorLabel: "NomNom Shopify auto-release", reason: "Auto-released from store integration" };
                api.queuePortalOrderReleaseEmail(order, context);
                api.queuePortalOrderConfirmationEmail(order, context);
                api.queuePortalOrderSplitFulfillmentNotice(order, context);
            }
        }
        console.log(JSON.stringify({
            mode: APPLY ? "apply" : "rollback-only",
            account: ACCOUNT,
            integrationId: INTEGRATION_ID,
            planHash: hash,
            draftCount: drafts.rowCount,
            eligible,
            blocked
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
