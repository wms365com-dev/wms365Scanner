const crypto = require("crypto");
const { Pool } = require("pg");

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

async function requestJson(url, accessToken) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-Shopify-Access-Token": accessToken
        },
        signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch (_error) {
        payload = {};
    }
    return {
        ok: response.ok,
        status: response.status,
        payload,
        error: response.ok
            ? ""
            : String(payload?.errors || payload?.error_description || payload?.error || response.statusText || "Request failed")
    };
}

async function main() {
    const shop = String(process.argv[2] || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
        throw new Error("Usage: node scripts/audit-shopify-connection-readonly.js store.myshopify.com");
    }

    const databaseUrl = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    if (!databaseUrl) throw new Error("DATABASE_URL is unavailable.");
    const secretKey = readEnv("INTEGRATION_SECRET_KEY") || readEnv("APP_SECRET") || readEnv("SESSION_SECRET");
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? false : { rejectUnauthorized: false }
    });

    try {
        const result = await pool.query(
            `select id, account_name, store_identifier, access_token, auth_client_id, auth_client_secret,
                    settings, import_status, is_active, sync_schedule
             from store_integrations
             where provider = 'SHOPIFY' and lower(store_identifier) = $1
             order by updated_at desc
             limit 1`,
            [shop]
        );
        const integration = result.rows[0];
        if (!integration) throw new Error(`No WMS365 Shopify connection exists for ${shop}.`);

        let accessToken = decryptSecret(integration.access_token, secretKey);
        const clientId = String(integration.auth_client_id || "").trim();
        const clientSecret = decryptSecret(integration.auth_client_secret, secretKey);
        let authentication = accessToken ? "saved_access_token" : "unavailable";

        if (clientId && clientSecret) {
            const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
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
            if (!tokenResponse.ok || !tokenPayload?.access_token) {
                throw new Error(`Shopify token request failed (${tokenResponse.status}): ${tokenPayload?.error_description || tokenPayload?.error || "No token returned"}`);
            }
            accessToken = String(tokenPayload.access_token);
            authentication = "client_credentials";
        }
        if (!accessToken) throw new Error("No usable Shopify credential is available.");

        const apiBase = `https://${shop}/admin/api/2026-01`;
        const [scopes, locations, products, productCatalog, orders] = await Promise.all([
            requestJson(`https://${shop}/admin/oauth/access_scopes.json`, accessToken),
            requestJson(`${apiBase}/locations.json`, accessToken),
            requestJson(`${apiBase}/products/count.json`, accessToken),
            requestJson(`${apiBase}/products.json?limit=250&fields=id,title,variants`, accessToken),
            requestJson(`${apiBase}/orders/count.json?status=any`, accessToken)
        ]);

        const scopeHandles = Array.isArray(scopes.payload?.access_scopes)
            ? scopes.payload.access_scopes.map((entry) => String(entry?.handle || "")).filter(Boolean).sort()
            : [];
        const checks = {
            scopes: { ok: scopes.ok, status: scopes.status, granted: scopeHandles, error: scopes.error },
            locations: {
                ok: locations.ok,
                status: locations.status,
                count: Array.isArray(locations.payload?.locations) ? locations.payload.locations.length : null,
                names: Array.isArray(locations.payload?.locations)
                    ? locations.payload.locations.map((location) => String(location?.name || "")).filter(Boolean)
                    : [],
                locations: Array.isArray(locations.payload?.locations)
                    ? locations.payload.locations.map((location) => ({
                        id: String(location?.id || ""),
                        name: String(location?.name || "")
                    }))
                    : [],
                error: locations.error
            },
            products: {
                ok: products.ok && productCatalog.ok,
                status: productCatalog.ok ? products.status : productCatalog.status,
                count: products.payload?.count ?? null,
                catalog: Array.isArray(productCatalog.payload?.products)
                    ? productCatalog.payload.products.flatMap((product) =>
                        (Array.isArray(product?.variants) ? product.variants : []).map((variant) => ({
                            product: String(product?.title || ""),
                            variant: String(variant?.title || ""),
                            sku: String(variant?.sku || ""),
                            barcode: String(variant?.barcode || ""),
                            inventoryItemId: String(variant?.inventory_item_id || ""),
                            inventoryManagement: String(variant?.inventory_management || ""),
                            inventoryPolicy: String(variant?.inventory_policy || "")
                        })))
                    : [],
                error: products.error || productCatalog.error
            },
            orders: { ok: orders.ok, status: orders.status, count: orders.payload?.count ?? null, error: orders.error }
        };

        const settings = integration.settings && typeof integration.settings === "object"
            ? integration.settings
            : {};
        const mappingResult = await pool.query(
            `select external_sku, local_sku, local_quantity_multiplier
             from store_sku_mappings
             where integration_id = $1`,
            [integration.id]
        );
        const catalog = checks.products.catalog || [];
        const inventoryItemIds = catalog
            .map((variant) => String(variant.inventoryItemId || ""))
            .filter(Boolean);
        const remoteInventory = inventoryItemIds.length && settings.shopifyLocationId
            ? await requestJson(
                `${apiBase}/inventory_levels.json?location_ids=${encodeURIComponent(String(settings.shopifyLocationId))}&inventory_item_ids=${encodeURIComponent(inventoryItemIds.join(","))}`,
                accessToken
            )
            : { ok: false, status: 0, payload: {}, error: "Shopify location or inventory item IDs unavailable." };
        const remoteAvailabilityByInventoryItem = new Map(
            (Array.isArray(remoteInventory.payload?.inventory_levels) ? remoteInventory.payload.inventory_levels : [])
                .map((level) => [String(level?.inventory_item_id || ""), Number(level?.available) || 0])
        );
        const wmsInventoryResult = await pool.query(
            `with allocated as (
                select inventory_line_id, coalesce(sum(allocated_quantity), 0)::int as allocated_quantity
                from portal_order_allocations a
                join portal_orders o on o.id = a.order_id
                where o.account_name = $1 and o.status = any($2::text[])
                group by inventory_line_id
             )
             select c.sku, c.description, c.tracking_level, c.unit_uom, c.units_per_case,
                    i.id as inventory_line_id, i.location, i.lot_number, i.expiration_date,
                    i.quantity as on_hand_quantity,
                    greatest(i.quantity - coalesce(a.allocated_quantity, 0), 0)::int as available_quantity,
                    coalesce(b.is_pickable, true) as is_pickable,
                    coalesce(b.location_type, 'STORAGE') as location_type
             from item_catalog c
             left join inventory_lines i on i.account_name = c.account_name and i.sku = c.sku
             left join allocated a on a.inventory_line_id = i.id
             left join bin_locations b on b.code = i.location
             where c.account_name = $1
             order by c.sku, i.location, i.lot_number, i.expiration_date`,
            [integration.account_name, ["RELEASED", "PICKED", "STAGED"]]
        );
        console.log(JSON.stringify({
            shop,
            accountName: integration.account_name,
            integrationId: integration.id,
            authentication,
            allChecksPassed: Object.values(checks).every((check) => check.ok),
            wmsConfiguration: {
                active: integration.is_active === true,
                importStatus: integration.import_status,
                syncSchedule: integration.sync_schedule,
                allowedShipCountries: settings.allowedShipCountries || [],
                shopifyLocationId: settings.shopifyLocationId || "",
                primaryLocationName: settings.primaryLocationName || "",
                syncOrders: settings.syncOrders === true,
                syncInventory: settings.syncInventory === true,
                syncShipmentConfirmations: settings.syncShipmentConfirmations === true,
                skuMappingCount: mappingResult.rowCount,
                skuMappings: mappingResult.rows.map((row) => ({
                    externalSku: row.external_sku,
                    localSku: row.local_sku,
                    localQuantityMultiplier: Number(row.local_quantity_multiplier) || 1,
                    shopifyAvailable: remoteAvailabilityByInventoryItem.get(
                        String(catalog.find((variant) => variant.sku === row.external_sku)?.inventoryItemId || "")
                    ) ?? null
                })),
                remoteInventoryCheck: {
                    ok: remoteInventory.ok,
                    status: remoteInventory.status,
                    error: remoteInventory.error
                },
                wmsInventory: wmsInventoryResult.rows.map((row) => ({
                    sku: row.sku,
                    description: row.description,
                    trackingLevel: row.tracking_level,
                    unitUom: row.unit_uom,
                    unitsPerCase: row.units_per_case,
                    location: row.location || "",
                    lotNumber: row.lot_number || "",
                    expirationDate: row.expiration_date || "",
                    onHandQuantity: Number(row.on_hand_quantity) || 0,
                    availableQuantity: Number(row.available_quantity) || 0,
                    isPickable: row.is_pickable === true,
                    locationType: row.location_type
                }))
            },
            checks
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
