"use strict";

const crypto = require("crypto");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const API_VERSION = "2026-01";
const CUTOFF = "2026-10-19T20:00:00.000Z";

function clean(value) {
    return String(value || "").trim().replace(/^(\"|')(.*)\1$/, "$2");
}

function decrypt(value, keyText) {
    const text = String(value || "");
    if (!text.startsWith("enc:v1:")) return text;
    if (!keyText) throw new Error("Integration encryption key is unavailable.");
    const [, version, iv, tag, ciphertext] = text.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Encrypted credential is malformed.");
    const key = crypto.createHash("sha256").update(keyText).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function main() {
    const connectionString = clean(process.env.DATABASE_PRIVATE_URL) || clean(process.env.DATABASE_URL);
    const key = clean(process.env.INTEGRATION_SECRET_KEY) || clean(process.env.APP_SECRET) || clean(process.env.SESSION_SECRET);
    if (!connectionString) throw new Error("Database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        await db.query("begin read only");
        const integration = (await db.query(
            `select * from store_integrations
             where id=4 and account_name=$1 and provider='SHOPIFY' and store_identifier=$2 and is_active`,
            [ACCOUNT, STORE]
        )).rows[0];
        if (!integration) throw new Error("Rancher's integration scope mismatch.");
        const tokenResponse = await fetch(`https://${STORE}/admin/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: String(integration.auth_client_id || ""),
                client_secret: decrypt(integration.auth_client_secret || "", key)
            }),
            signal: AbortSignal.timeout(30000)
        });
        const tokenPayload = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error(`Shopify authentication failed (${tokenResponse.status}).`);
        const params = new URLSearchParams({
            status: "open",
            limit: "250",
            created_at_min: CUTOFF,
            fields: "id,name,created_at,cancelled_at,closed_at,fulfillment_status,financial_status,shipping_address,line_items"
        });
        const response = await fetch(`https://${STORE}/admin/api/${API_VERSION}/orders.json?${params}`, {
            headers: { Accept: "application/json", "X-Shopify-Access-Token": String(tokenPayload.access_token) },
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(payload.orders)) throw new Error(`Shopify order read failed (${response.status}).`);

        const pending = payload.orders.filter((order) => !order.cancelled_at && !order.closed_at
            && order.fulfillment_status !== "fulfilled"
            && String(order.shipping_address?.country_code || "").toUpperCase() === "CA"
            && (order.line_items || []).some((line) => line.requires_shipping !== false
                && Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) > 0));
        const externalIds = pending.map((order) => String(order.id));
        const imports = externalIds.length ? (await db.query(
            `select split_part(si.external_order_id,'/',array_length(string_to_array(si.external_order_id,'/'),1)) external_id,
                    o.order_code, o.status, o.created_at,
                    coalesce(sum(a.allocated_quantity),0)::int allocated_quantity,
                    coalesce(sum(l.requested_quantity),0)::int requested_quantity
             from store_order_imports si
             join portal_orders o on o.id=si.portal_order_id
             join portal_order_lines l on l.order_id=o.id
             left join portal_order_allocations a on a.order_line_id=l.id
             where si.integration_id=4 and o.account_name=$1
               and split_part(si.external_order_id,'/',array_length(string_to_array(si.external_order_id,'/'),1))=any($2::text[])
             group by external_id,o.order_code,o.status,o.created_at`,
            [ACCOUNT, externalIds]
        )).rows : [];
        const byExternal = new Map(imports.map((row) => [String(row.external_id), row]));
        await db.query("rollback");
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            cutoffUtc: CUTOFF,
            cutoffEastern: "2026-10-19 4:00 PM EDT",
            integration: {
                schedule: integration.sync_schedule,
                lastSyncedAt: integration.last_synced_at,
                lastSyncStatus: integration.last_sync_status,
                lastSyncMessage: integration.last_sync_message,
                nextScheduledSyncAt: integration.next_scheduled_sync_at,
                syncClaimedAt: integration.sync_claimed_at
            },
            pendingCanadianOrdersCreatedSinceCutoff: pending.map((order) => {
                const imported = byExternal.get(String(order.id));
                return {
                    shopifyOrder: order.name,
                    createdAt: order.created_at,
                    financialStatus: order.financial_status,
                    skus: (order.line_items || []).map((line) => String(line.sku || "(blank SKU)")),
                    wmsOrder: imported?.order_code || null,
                    wmsStatus: imported?.status || null,
                    fullyAllocated: imported ? Number(imported.allocated_quantity) === Number(imported.requested_quantity) : false
                };
            })
        }, null, 2));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
