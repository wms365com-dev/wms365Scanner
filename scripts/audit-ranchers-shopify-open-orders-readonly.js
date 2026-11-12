const crypto = require("crypto");
const { Pool } = require("pg");

const ACCOUNT_NAME = "RANCHER'S CHIPS";
const SHOP_DOMAIN = "f1acxk-dc.myshopify.com";
const SHOPIFY_API_VERSION = "2026-01";

function readEnv(name) {
    return String(process.env[name] || "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

function decryptSecret(value, secretKey) {
    const text = String(value || "");
    if (!text || !text.startsWith("enc:v1:")) return text;
    const [, version, ivText, tagText, ciphertextText] = text.split(":");
    if (!secretKey || version !== "v1") throw new Error("Integration credential cannot be decrypted.");
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64")),
        decipher.final()
    ]).toString("utf8");
}

function nextLink(header) {
    const match = String(header || "").match(/<([^>]+)>;\s*rel="next"/i);
    return match?.[1] || "";
}

async function main() {
    const databaseUrl = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    const secretKey = readEnv("INTEGRATION_SECRET_KEY") || readEnv("APP_SECRET") || readEnv("SESSION_SECRET");
    if (!databaseUrl) throw new Error("DATABASE_URL is unavailable.");
    const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

    try {
        const result = await pool.query(
            `select * from store_integrations
             where account_name = $1 and provider = 'SHOPIFY' and lower(store_identifier) = $2
             limit 1`,
            [ACCOUNT_NAME, SHOP_DOMAIN]
        );
        const integration = result.rows[0];
        if (!integration) throw new Error("Rancher's Shopify integration was not found.");
        const tokenResponse = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: String(integration.auth_client_id || ""),
                client_secret: decryptSecret(integration.auth_client_secret || "", secretKey)
            }),
            signal: AbortSignal.timeout(30000)
        });
        const tokenPayload = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error("Shopify token request failed.");
        const accessToken = String(tokenPayload.access_token);

        const mappings = await pool.query(
            `select external_sku, local_sku, local_quantity_multiplier
             from store_sku_mappings where integration_id = $1`,
            [integration.id]
        );
        const mappedSkus = new Set(mappings.rows.map((row) => row.external_sku));
        const fields = "id,name,created_at,processed_at,shipping_address,line_items,cancelled_at,financial_status,fulfillment_status";
        let url = `https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=open&limit=250&fields=${encodeURIComponent(fields)}`;
        const orders = [];
        for (let page = 0; url && page < 20; page += 1) {
            const response = await fetch(url, {
                headers: { Accept: "application/json", "X-Shopify-Access-Token": accessToken },
                signal: AbortSignal.timeout(30000)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(`Shopify order audit failed (${response.status}).`);
            orders.push(...(Array.isArray(payload.orders) ? payload.orders : []));
            url = nextLink(response.headers.get("link"));
        }

        const activeOrders = orders.filter((order) => !order.cancelled_at);
        const canadianOrders = activeOrders.filter((order) =>
            String(order?.shipping_address?.country_code || "").trim().toUpperCase() === "CA"
        );
        const skuSummary = new Map();
        for (const order of canadianOrders) {
            for (const line of order.line_items || []) {
                const sku = String(line.sku || "").trim() || "(blank SKU)";
                const current = skuSummary.get(sku) || { sku, orderCount: 0, shopifyUnits: 0, mapped: mappedSkus.has(sku) };
                current.orderCount += 1;
                current.shopifyUnits += Number(line.quantity) || 0;
                skuSummary.set(sku, current);
            }
        }
        const createdDates = canadianOrders
            .map((order) => new Date(order.created_at))
            .filter((date) => Number.isFinite(date.getTime()))
            .sort((a, b) => a - b);

        console.log(JSON.stringify({
            ok: true,
            orderImportAttempted: false,
            totalOpenOrders: activeOrders.length,
            openCanadianOrders: canadianOrders.length,
            earliestCanadianOrderCreatedAt: createdDates[0]?.toISOString() || null,
            latestCanadianOrderCreatedAt: createdDates.at(-1)?.toISOString() || null,
            skuSummary: [...skuSummary.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
            unmappedSkus: [...skuSummary.values()].filter((row) => !row.mapped).map((row) => row.sku)
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
