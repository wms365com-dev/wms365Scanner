"use strict";

const { Client } = require("pg");
const { decryptStoreIntegrationRow } = require("../server");

const ACCOUNT = "NOMMM CANADA INC.";
const INTEGRATION_ID = 6;
const STORE = "fresh-canvas-studio-74lsu.myshopify.com";

function text(value) {
    return String(value == null ? "" : value).trim();
}

function plainHtml(value) {
    return text(value)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, " ")
        .trim();
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection unavailable.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const result = await client.query(
            `select * from store_integrations
              where id=$1 and account_name=$2 and provider='SHOPIFY'
                and lower(store_identifier)=$3 and is_active=true`,
            [INTEGRATION_ID, ACCOUNT, STORE]
        );
        if (result.rowCount !== 1) throw new Error("Exact active NomNom Shopify integration was not found.");
        const integration = decryptStoreIntegrationRow(result.rows[0]);
        const response = await fetch(
            `https://${STORE}/admin/api/2026-01/products.json?limit=250&status=active&fields=id,title,handle,body_html,variants`,
            { headers: { "X-Shopify-Access-Token": integration.access_token, Accept: "application/json" } }
        );
        if (!response.ok) throw new Error(`Shopify product audit failed with HTTP ${response.status}.`);
        const payload = await response.json();
        const products = (payload.products || []).map((product) => ({
            productId: text(product.id),
            title: text(product.title),
            handle: text(product.handle),
            description: plainHtml(product.body_html),
            variants: (product.variants || []).map((variant) => ({
                variantId: text(variant.id),
                title: text(variant.title),
                sku: text(variant.sku)
            }))
        }));
        await client.query("rollback");
        console.log(JSON.stringify({ readOnly: true, account: ACCOUNT, integrationId: INTEGRATION_ID, store: STORE, products }, null, 2));
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
