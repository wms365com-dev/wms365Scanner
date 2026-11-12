"use strict";

const crypto = require("crypto");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const API_VERSION = "2026-01";
const TARGETS = new Set((process.argv.find((arg) => arg.startsWith("--orders=")) || "--orders=")
    .slice("--orders=".length).split(",").map((value) => value.trim().replace(/^#/, "")).filter(Boolean));

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

function nextLink(value) {
    return String(value || "").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
}

async function main() {
    if (!TARGETS.size) throw new Error("At least one --orders value is required.");
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
        const headers = { Accept: "application/json", "X-Shopify-Access-Token": String(tokenPayload.access_token) };

        const scopesResponse = await fetch(`https://${STORE}/admin/oauth/access_scopes.json`, {
            headers, signal: AbortSignal.timeout(30000)
        });
        const scopesPayload = await scopesResponse.json().catch(() => ({}));
        if (!scopesResponse.ok) throw new Error(`Shopify scope read failed (${scopesResponse.status}).`);
        const scopes = (scopesPayload.access_scopes || []).map((scope) => scope.handle);

        const countResponse = await fetch(`https://${STORE}/admin/api/${API_VERSION}/orders/count.json?status=open`, {
            headers, signal: AbortSignal.timeout(30000)
        });
        const countPayload = await countResponse.json().catch(() => ({}));
        if (!countResponse.ok || !Number.isInteger(countPayload.count)) throw new Error("Shopify open-order count failed.");

        const fields = "id,name,created_at,shipping_address,line_items,cancelled_at,closed_at,fulfillment_status,financial_status";
        let url = `https://${STORE}/admin/api/${API_VERSION}/orders.json?status=open&limit=250&fields=${fields}`;
        const orders = [];
        while (url) {
            const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(payload.orders)) throw new Error(`Shopify open-order read failed (${response.status}).`);
            orders.push(...payload.orders);
            url = nextLink(response.headers.get("link"));
        }

        const targetOrders = orders.filter((order) => TARGETS.has(String(order.name || "").replace(/^#/, "")));
        const externalIds = targetOrders.map((order) => String(order.id));
        const imports = externalIds.length ? (await db.query(
            `select split_part(s.external_order_id,'/',array_length(string_to_array(s.external_order_id,'/'),1)) as external_id,
                    o.order_code, o.status, o.fulfillment_location_id
             from store_order_imports s
             join portal_orders o on o.id=s.portal_order_id
             where s.integration_id=4 and o.account_name=$1
               and split_part(s.external_order_id,'/',array_length(string_to_array(s.external_order_id,'/'),1)) = any($2::text[])`,
            [ACCOUNT, externalIds]
        )).rows : [];
        const byExternalId = new Map(imports.map((row) => [String(row.external_id), row]));
        const orderCodes = imports.map((row) => row.order_code);
        const readinessRows = orderCodes.length ? (await db.query(
            `select o.order_code, l.sku, l.requested_quantity,
                    coalesce(sum(a.allocated_quantity), 0)::int as allocated_quantity,
                    coalesce((select sum(i.quantity)::int from inventory_lines i
                              where i.account_name=o.account_name and i.sku=l.sku), 0) as on_hand
             from portal_orders o
             join portal_order_lines l on l.order_id=o.id
             left join portal_order_allocations a on a.order_line_id=l.id
             where o.account_name=$1 and o.order_code=any($2::text[])
             group by o.order_code, l.id, l.sku, l.requested_quantity, o.account_name
             order by o.order_code, l.id`,
            [ACCOUNT, orderCodes]
        )).rows : [];
        const readinessByOrder = new Map();
        for (const row of readinessRows) {
            if (!readinessByOrder.has(row.order_code)) readinessByOrder.set(row.order_code, []);
            readinessByOrder.get(row.order_code).push({
                sku: row.sku,
                requestedQuantity: Number(row.requested_quantity),
                allocatedQuantity: Number(row.allocated_quantity),
                onHand: Number(row.on_hand)
            });
        }
        const foundNames = new Set(targetOrders.map((order) => String(order.name || "").replace(/^#/, "")));

        await db.query("rollback");
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            openCountReported: countPayload.count,
            openOrdersAccessible: orders.length,
            hasReadAllOrders: scopes.includes("read_all_orders"),
            integrationImportStatus: integration.import_status,
            requestedOrders: [...TARGETS].map((number) => `#${number}`),
            inaccessibleOrNotOpen: [...TARGETS].filter((number) => !foundNames.has(number)).map((number) => `#${number}`),
            results: targetOrders.map((order) => ({
                shopifyOrder: order.name,
                createdAt: order.created_at,
                financialStatus: order.financial_status,
                fulfillmentStatus: order.fulfillment_status,
                country: String(order.shipping_address?.country_code || "").toUpperCase(),
                lines: (order.line_items || []).map((line) => ({
                    sku: String(line.sku || ""),
                    quantity: Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity),
                    requiresShipping: line.requires_shipping !== false
                })),
                wms: byExternalId.get(String(order.id)) || null,
                readiness: readinessByOrder.get(byExternalId.get(String(order.id))?.order_code) || []
            }))
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
