const crypto = require("crypto");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const API_VERSION = "2026-01";

function clean(value) {
    return String(value || "").trim().replace(/^(["'])(.*)\1$/, "$2");
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

function nextLink(value) {
    return String(value || "").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
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
        const warehouse = await db.query("select 1 from fulfillment_locations where id=1 and code='GW3PL-MISS' and is_active=true");
        if (warehouse.rowCount !== 1) throw new Error("Rancher's warehouse scope mismatch.");

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
        const headers = { Accept: "application/json", "X-Shopify-Access-Token": String(tokenPayload.access_token) };

        const countResponse = await fetch(`https://${STORE}/admin/api/${API_VERSION}/orders/count.json?status=open`, {
            headers, signal: AbortSignal.timeout(30000)
        });
        const countPayload = await countResponse.json().catch(() => ({}));
        if (!countResponse.ok || !Number.isInteger(countPayload.count)) throw new Error("Shopify open-order count failed.");

        const fields = "id,name,created_at,shipping_address,line_items,cancelled_at,closed_at,fulfillment_status,financial_status";
        let url = `https://${STORE}/admin/api/${API_VERSION}/orders.json?status=open&limit=250&fields=${fields}`;
        const orders = [];
        const seen = new Set();
        let pages = 0;
        while (url) {
            const parsed = new URL(url);
            if (parsed.origin !== `https://${STORE}` || !parsed.pathname.startsWith(`/admin/api/${API_VERSION}/`)) {
                throw new Error("Shopify pagination escaped the pinned store.");
            }
            const response = await fetch(parsed, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(payload.orders)) throw new Error(`Shopify open-order read failed (${response.status}).`);
            pages += 1;
            for (const order of payload.orders) {
                const id = String(order.id);
                if (seen.has(id)) throw new Error("Duplicate Shopify order encountered during pagination.");
                seen.add(id);
                orders.push(order);
            }
            url = nextLink(response.headers.get("link"));
            if (pages > 20) throw new Error("Shopify open-order pagination exceeded its safety bound.");
        }
        if (orders.length !== countPayload.count) throw new Error(`Shopify count/read mismatch: ${countPayload.count}/${orders.length}.`);

        const imports = (await db.query(
            `select split_part(s.external_order_id,'/',array_length(string_to_array(s.external_order_id,'/'),1)) as external_id,
                    o.order_code,o.status,o.fulfillment_location_id
             from store_order_imports s join portal_orders o on o.id=s.portal_order_id
             where s.integration_id=4 and o.account_name=$1`,
            [ACCOUNT]
        )).rows;
        const byExternalId = new Map(imports.map((row) => [String(row.external_id), row]));
        const pending = orders.filter((order) => !order.cancelled_at && !order.closed_at
            && order.fulfillment_status !== "fulfilled"
            && (order.line_items || []).some((line) => line.requires_shipping !== false
                && Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) > 0));
        const missing = pending.filter((order) => !byExternalId.has(String(order.id)));
        const linked = pending.map((order) => ({ order, wms: byExternalId.get(String(order.id)) })).filter((entry) => entry.wms);
        const wrongWarehouse = linked.filter((entry) => Number(entry.wms.fulfillment_location_id) !== 1);

        const summarize = (order) => ({
            shopifyOrder: order.name,
            externalId: String(order.id),
            createdAt: order.created_at,
            country: String(order.shipping_address?.country_code || "").toUpperCase(),
            financialStatus: order.financial_status,
            lines: (order.line_items || []).filter((line) => line.requires_shipping !== false
                && Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) > 0)
                .map((line) => ({ sku: String(line.sku || ""), title: line.title,
                    variant: line.variant_title, fulfillableQuantity: Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) }))
        });
        const statusCounts = {};
        for (const entry of linked) statusCounts[entry.wms.status] = (statusCounts[entry.wms.status] || 0) + 1;

        await db.query("rollback");
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            shopifyOpenCount: countPayload.count,
            openOrdersRead: orders.length,
            pages,
            pendingPhysicalOpenCount: pending.length,
            matchedPendingCount: pending.length - missing.length,
            missingPendingCount: missing.length,
            missingPendingOrders: missing.map(summarize),
            matchedWmsStatusCounts: statusCounts,
            wrongWarehouseCount: wrongWarehouse.length,
            wrongWarehouseOrders: wrongWarehouse.map((entry) => ({ shopifyOrder: entry.order.name, wmsOrder: entry.wms.order_code }))
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
