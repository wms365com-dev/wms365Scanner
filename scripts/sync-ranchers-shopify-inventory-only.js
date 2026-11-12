const crypto = require("crypto");
const { Client } = require("pg");

const ACCOUNT_NAME = "RANCHER'S CHIPS";
const SHOP_DOMAIN = "f1acxk-dc.myshopify.com";
const SHOPIFY_API_VERSION = "2026-01";

function readEnv(name) {
    return String(process.env[name] || "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

function decryptSecret(value, secretKey) {
    const text = String(value || "");
    if (!text || !text.startsWith("enc:v1:")) return text;
    if (!secretKey) throw new Error("Integration encryption key is unavailable.");
    const [, version, ivText, tagText, ciphertextText] = text.split(":");
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
        throw new Error("Encrypted integration credential is malformed.");
    }
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64")),
        decipher.final()
    ]).toString("utf8");
}

async function shopifyRequest(path, accessToken, { method = "GET", body = null, allowStatus = [] } = {}) {
    const response = await fetch(`https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
        method,
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok && !allowStatus.includes(response.status)) {
        throw new Error(`Shopify ${method} ${path} failed (${response.status}): ${JSON.stringify(payload?.errors || payload)}`);
    }
    return { ok: response.ok, status: response.status, payload };
}

async function main() {
    const connectionString = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const secretKey = readEnv("INTEGRATION_SECRET_KEY") || readEnv("APP_SECRET") || readEnv("SESSION_SECRET");
    const client = new Client({
        connectionString,
        ssl: /localhost|127\.0\.0\.1/i.test(connectionString) ? false : { rejectUnauthorized: false }
    });
    await client.connect();

    try {
        const integrationResult = await client.query(
            `select * from store_integrations
             where account_name = $1 and provider = 'SHOPIFY' and lower(store_identifier) = $2
             limit 1`,
            [ACCOUNT_NAME, SHOP_DOMAIN]
        );
        const integration = integrationResult.rows[0];
        if (!integration) throw new Error("Rancher's Shopify integration was not found.");
        const settings = integration.settings && typeof integration.settings === "object" ? integration.settings : {};
        const locationId = String(settings.shopifyLocationId || "").trim();
        if (!locationId) throw new Error("Rancher's Shopify location is not configured.");

        const clientId = String(integration.auth_client_id || "").trim();
        const clientSecret = decryptSecret(integration.auth_client_secret || "", secretKey);
        const tokenResponse = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret
            }),
            signal: AbortSignal.timeout(30000)
        });
        const tokenPayload = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenPayload.access_token) {
            throw new Error(`Shopify token request failed (${tokenResponse.status}).`);
        }
        const accessToken = String(tokenPayload.access_token);

        const [mappingResult, availabilityResult, productsResponse] = await Promise.all([
            client.query(
                `select external_sku, local_sku, local_quantity_multiplier
                 from store_sku_mappings where integration_id = $1
                 order by id`,
                [integration.id]
            ),
            client.query(
                `with allocated as (
                    select a.inventory_line_id, coalesce(sum(a.allocated_quantity), 0)::int as allocated_quantity
                    from portal_order_allocations a
                    join portal_orders o on o.id = a.order_id
                    where o.account_name = $1 and o.status = any($2::text[])
                    group by a.inventory_line_id
                 )
                 select i.sku,
                        coalesce(sum(case
                            when coalesce(b.is_pickable, true) = true
                             and coalesce(b.location_type, 'STORAGE') not in ('DAMAGED','HOLD','INVESTIGATION','QC','QUARANTINE')
                            then greatest(i.quantity - coalesce(a.allocated_quantity, 0), 0)
                            else 0
                        end), 0)::int as available_quantity
                 from inventory_lines i
                 left join bin_locations b on b.code = i.location
                 left join allocated a on a.inventory_line_id = i.id
                 where i.account_name = $1
                 group by i.sku`,
                [ACCOUNT_NAME, ["RELEASED", "PICKED", "STAGED"]]
            ),
            shopifyRequest("/products.json?limit=250&fields=id,title,variants", accessToken)
        ]);

        const availableBySku = new Map(availabilityResult.rows.map((row) => [row.sku, Number(row.available_quantity) || 0]));
        const variants = (productsResponse.payload.products || []).flatMap((product) =>
            (product.variants || []).map((variant) => ({ ...variant, productTitle: product.title }))
        );
        const variantBySku = new Map(variants.map((variant) => [String(variant.sku || ""), variant]));
        const updates = [];

        for (const mapping of mappingResult.rows) {
            const variant = variantBySku.get(mapping.external_sku);
            if (!variant) throw new Error(`Shopify variant ${mapping.external_sku} was not found.`);
            const multiplier = Math.max(Number(mapping.local_quantity_multiplier) || 1, 1);
            const localAvailable = Math.max(availableBySku.get(mapping.local_sku) || 0, 0);
            const available = Math.floor(localAvailable / multiplier);
            const inventoryItemId = String(variant.inventory_item_id || "");

            let setResult = await shopifyRequest("/inventory_levels/set.json", accessToken, {
                method: "POST",
                body: {
                    location_id: Number(locationId),
                    inventory_item_id: Number(inventoryItemId),
                    available,
                    disconnect_if_necessary: false
                },
                allowStatus: [422]
            });
            if (!setResult.ok) {
                await shopifyRequest("/inventory_levels/connect.json", accessToken, {
                    method: "POST",
                    body: {
                        location_id: Number(locationId),
                        inventory_item_id: Number(inventoryItemId),
                        relocate_if_necessary: false
                    },
                    allowStatus: [422]
                });
                setResult = await shopifyRequest("/inventory_levels/set.json", accessToken, {
                    method: "POST",
                    body: {
                        location_id: Number(locationId),
                        inventory_item_id: Number(inventoryItemId),
                        available,
                        disconnect_if_necessary: false
                    }
                });
            }

            updates.push({
                shopifySku: mapping.external_sku,
                localSku: mapping.local_sku,
                unitsPerShopifyItem: multiplier,
                localAvailable,
                shopifyAvailable: Number(setResult.payload?.inventory_level?.available ?? available),
                oversellPolicy: String(variant.inventory_policy || "")
            });
        }

        const policyWarnings = updates
            .filter((entry) => entry.oversellPolicy !== "deny")
            .map((entry) => entry.shopifySku);
        await client.query(
            `update store_integrations
             set last_synced_at = now(), last_sync_status = $2, last_sync_message = $3, updated_at = now()
             where id = $1`,
            [
                integration.id,
                policyWarnings.length ? "WARNING" : "SUCCESS",
                `Inventory-only sync sent ${updates.length} levels. Order import not attempted.${policyWarnings.length ? ` Oversell policy remains enabled for: ${policyWarnings.join(", ")}.` : ""}`
            ]
        );
        await client.query(
            `insert into activity_log (type, title, details) values ('integration', $1, $2)`,
            [
                `Published Rancher's shared inventory to Shopify`,
                `${updates.length} mapped variants | ${availableBySku.get("RTC-4OZ-12") || 0} EA available | order import not attempted`
            ]
        );

        console.log(JSON.stringify({
            ok: true,
            accountName: ACCOUNT_NAME,
            shop: SHOP_DOMAIN,
            shopifyLocationId: locationId,
            orderImportAttempted: false,
            updates,
            policyWarnings,
            automaticSyncEnabled: integration.sync_schedule !== "MANUAL"
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
