"use strict";

const { Client } = require("pg");
const { decryptStoreIntegrationRow } = require("../server");

const ACCOUNT = "NOMMM CANADA INC.";
const INTEGRATION_ID = 6;
const GIFT_PRODUCT_ID = "8578951446720";
const GIFT_SKU = "NOMMM-FOUNDER-GIFT-3PK";
const GIFT_COMPONENTS = ["NN95034", "NN95035", "NN95033"];
const APPLY = process.argv.includes("--apply");

function normalize(value) {
    return String(value == null ? "" : value).trim();
}

function nextLink(header) {
    const value = normalize(header);
    const match = value.match(/<([^>]+)>;\s*rel="next"/i);
    return match ? match[1] : "";
}

async function shopifyJson(url, token) {
    const response = await fetch(url, {
        headers: {
            "X-Shopify-Access-Token": token,
            Accept: "application/json"
        }
    });
    if (!response.ok) throw new Error(`Shopify catalog request failed with HTTP ${response.status}.`);
    return {
        body: await response.json(),
        next: nextLink(response.headers.get("link"))
    };
}

async function fetchCatalog(store, token) {
    let url = `https://${store}/admin/api/2026-01/products.json?limit=250&status=active&fields=id,title,status,variants`;
    const products = [];
    while (url) {
        const page = await shopifyJson(url, token);
        products.push(...(Array.isArray(page.body?.products) ? page.body.products : []));
        url = page.next;
    }
    return products;
}

function flattenVariants(products) {
    return products.flatMap((product) => (product.variants || []).map((variant) => ({
        productId: normalize(product.id),
        productTitle: normalize(product.title),
        variantId: normalize(variant.id),
        variantTitle: normalize(variant.title),
        sku: normalize(variant.sku),
        description: normalize(variant.title) && normalize(variant.title).toLowerCase() !== "default title"
            ? `${normalize(product.title)} - ${normalize(variant.title)}`
            : normalize(product.title)
    })));
}

async function loadScope(client) {
    const result = await client.query(
        `select * from store_integrations where id=$1 and account_name=$2 and provider='SHOPIFY' limit 2`,
        [INTEGRATION_ID, ACCOUNT]
    );
    if (result.rowCount !== 1) throw new Error("Exact NomNom Shopify integration identity was not found.");
    const integration = decryptStoreIntegrationRow(result.rows[0]);
    if (integration.is_active !== true) throw new Error("NomNom Shopify integration is not active.");
    const store = normalize(integration.store_identifier).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) throw new Error("NomNom Shopify store identity is invalid.");
    const token = normalize(integration.access_token);
    if (!token) throw new Error("NomNom Shopify credential is unavailable.");
    return { store, token };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_PRIVATE_URL or DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin");
        if (!APPLY) await client.query("set transaction read only");
        if (APPLY) await client.query("select pg_advisory_xact_lock(hashtext($1))", [`nommm-shopify-catalog:${INTEGRATION_ID}`]);

        const { store, token } = await loadScope(client);
        const products = await fetchCatalog(store, token);
        const variants = flattenVariants(products);
        const blankSkuCount = variants.filter((variant) => !variant.sku).length;
        const bySku = new Map();
        for (const variant of variants) {
            if (!variant.sku) continue;
            if (!bySku.has(variant.sku)) bySku.set(variant.sku, []);
            bySku.get(variant.sku).push(variant);
        }
        const duplicateSkus = [...bySku].filter(([, rows]) => rows.length > 1).map(([sku]) => sku).sort();
        if (blankSkuCount || duplicateSkus.length) {
            throw new Error(`Shopify catalog is unsafe to reconcile: ${blankSkuCount} blank SKU variant(s), ${duplicateSkus.length} duplicate SKU(s).`);
        }

        const giftVariants = variants.filter((variant) => variant.productId === GIFT_PRODUCT_ID);
        if (giftVariants.length !== 1 || giftVariants[0].sku !== GIFT_SKU) {
            throw new Error(`Shopify product ${GIFT_PRODUCT_ID} must have exactly one variant with SKU ${GIFT_SKU}.`);
        }

        const skuList = [...bySku.keys()].sort();
        const existingItems = await client.query(
            `select sku from item_catalog where account_name=$1 and sku=any($2::text[])`,
            [ACCOUNT, skuList]
        );
        const existingItemSkus = new Set(existingItems.rows.map((row) => normalize(row.sku)));
        const existingMappings = await client.query(
            `select external_sku,local_sku,local_quantity_multiplier from store_sku_mappings where integration_id=$1`,
            [INTEGRATION_ID]
        );
        const mappingByExternal = new Map(existingMappings.rows.map((row) => [normalize(row.external_sku), row]));
        const conflicts = skuList.filter((sku) => {
            const mapping = mappingByExternal.get(sku);
            return mapping && (normalize(mapping.local_sku) !== sku || Number(mapping.local_quantity_multiplier) !== 1);
        });
        if (conflicts.length) throw new Error(`Existing Shopify SKU mapping conflict(s): ${conflicts.join(", ")}`);

        const components = await client.query(
            `select sku,tracking_level,unit_uom,blocked from item_catalog where account_name=$1 and sku=any($2::text[])`,
            [ACCOUNT, GIFT_COMPONENTS]
        );
        const componentBySku = new Map(components.rows.map((row) => [normalize(row.sku), row]));
        const invalidComponents = GIFT_COMPONENTS.filter((sku) => {
            const item = componentBySku.get(sku);
            return !item || item.blocked === true || normalize(item.tracking_level) !== "UNIT" || !["", "EACH", "EA"].includes(normalize(item.unit_uom).toUpperCase());
        });
        if (invalidComponents.length) throw new Error(`Gift component item(s) are missing, blocked, or not each-level: ${invalidComponents.join(", ")}`);

        const missingItems = skuList.filter((sku) => !existingItemSkus.has(sku));
        const missingMappings = skuList.filter((sku) => !mappingByExternal.has(sku));
        if (APPLY) {
            for (const sku of missingItems) {
                const variant = bySku.get(sku)[0];
                await client.query(
                    `insert into item_catalog (account_name,sku,description,tracking_level,unit_uom,item_type,blocked)
                     values ($1,$2,$3,'UNIT','EACH',$4,false)
                     on conflict (account_name,sku) do nothing`,
                    [ACCOUNT, sku, variant.description || sku, sku === GIFT_SKU ? "NON_INVENTORY" : "INVENTORY"]
                );
            }
            for (const sku of missingMappings) {
                await client.query(
                    `insert into store_sku_mappings (account_name,integration_id,local_sku,external_sku,local_quantity_multiplier,note)
                     values ($1,$2,$3,$3,1,$4)
                     on conflict (integration_id,external_sku) do nothing`,
                    [ACCOUNT, INTEGRATION_ID, sku, "Verified from active NomNom Shopify catalog"]
                );
            }
            await client.query(`delete from item_kit_components where account_name=$1 and parent_sku=$2`, [ACCOUNT, GIFT_SKU]);
            for (const componentSku of GIFT_COMPONENTS) {
                await client.query(
                    `insert into item_kit_components (account_name,parent_sku,component_sku,quantity_per_parent,note)
                     values ($1,$2,$3,2,$4)`,
                    [ACCOUNT, GIFT_SKU, componentSku, `Shopify product ${GIFT_PRODUCT_ID}; approved founding gift entitlement`]
                );
            }
        }

        const summary = {
            mode: APPLY ? "apply" : "read-only",
            company: ACCOUNT,
            integrationId: INTEGRATION_ID,
            store,
            activeProducts: products.length,
            variants: variants.length,
            missingItems: missingItems.length,
            missingMappings: missingMappings.length,
            mappingConflicts: conflicts.length,
            blankSkuVariants: blankSkuCount,
            duplicateSkus: duplicateSkus.length,
            founderGift: { productId: GIFT_PRODUCT_ID, sku: GIFT_SKU, componentCount: GIFT_COMPONENTS.length, eachesPerComponent: 2 }
        };
        if (APPLY) await client.query("commit");
        else await client.query("rollback");
        console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
