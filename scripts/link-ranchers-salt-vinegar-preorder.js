const { Client } = require("pg");
const {
    applyStoreSkuMappingsToPortalOrderPayload,
    claimStoreIntegrationSync,
    decryptStoreIntegrationRow,
    getShopifyOrderShipCountryDecision,
    mapShopifyOrderToPortalDraft,
    releaseStoreIntegrationSyncClaim,
    savePortalOrderDraftForAccount,
    sanitizeStoreIntegrationSettingsInput
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const INTEGRATION_ID = 4;
const OWNER_ID = 5062;
const LOCAL_SKU = "RTC-SV-EA";
const EXTERNAL_SKU = "RTC-SV-12-PACK";
const PACK_SIZE = 12;
const PRODUCT_TITLE = "PREORDER - Rancher's Salt & Vinegar";
const VARIANT_TITLE = "12 Pack";

async function shopifyGet(integration, path) {
    const response = await fetch(`https://${STORE}/admin/api/2026-01${path}`, {
        headers: { Accept: "application/json", "X-Shopify-Access-Token": integration.access_token },
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Shopify read failed (${response.status}).`);
    return { body: await response.json(), next: (response.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "" };
}

async function readShopifyScope(client, integration, settings) {
    const fields = ["id", "name", "order_number", "po_number", "created_at", "processed_at",
        "email", "phone", "tags", "note", "shipping_address", "billing_address", "customer",
        "line_items", "cancelled_at", "financial_status"].join(",");
    let url = `https://${STORE}/admin/api/2026-01/orders.json?status=open&limit=250&fields=${fields}`;
    const orders = [];
    for (let page = 0; url && page < 8; page += 1) {
        const path = new URL(url).pathname.replace("/admin/api/2026-01", "") + new URL(url).search;
        const result = await shopifyGet(integration, path);
        orders.push(...(result.body.orders || []).filter((order) => !order.cancelled_at));
        url = result.next;
    }
    if (url) throw new Error("Shopify order pagination exceeded the safety limit.");

    const allowedOrders = orders.filter((order) => getShopifyOrderShipCountryDecision(order, settings).allowed);
    const candidates = allowedOrders
        .flatMap((order) => (order.line_items || []).filter((line) =>
            Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) > 0
            && String(line.title || "").includes("Salt & Vinegar")
        ));
    const variantIds = new Set(candidates.map((line) => String(line.variant_id || "")));
    const productIds = new Set(candidates.map((line) => String(line.product_id || "")));
    if (!candidates.length || variantIds.size !== 1 || productIds.size !== 1 || variantIds.has("") || productIds.has("")) {
        throw new Error("Expected exactly one eligible Salt & Vinegar Shopify variant and product.");
    }

    const variantId = [...variantIds][0];
    const productId = [...productIds][0];
    const product = (await shopifyGet(integration, `/products/${productId}.json?fields=id,title,variants`)).body.product;
    const variant = (product?.variants || []).find((row) => String(row.id) === variantId);
    if (product?.title !== PRODUCT_TITLE || variant?.title !== VARIANT_TITLE
        || !["", EXTERNAL_SKU].includes(String(variant?.sku || ""))
        || variant.inventory_policy !== "continue" || variant.inventory_management !== "shopify") {
        throw new Error("Shopify preorder product, variant, SKU, or inventory policy changed.");
    }
    if (candidates.some((line) => !["", EXTERNAL_SKU].includes(String(line.sku || "")))) {
        throw new Error("Shopify order lines disagree with the live variant SKU.");
    }

    let variantUrl = `https://${STORE}/admin/api/2026-01/variants.json?limit=250&fields=id,sku`;
    for (let page = 0; variantUrl && page < 8; page += 1) {
        const parsed = new URL(variantUrl);
        const result = await shopifyGet(integration, parsed.pathname.replace("/admin/api/2026-01", "") + parsed.search);
        if ((result.body.variants || []).some((row) => String(row.sku || "") === EXTERNAL_SKU && String(row.id) !== variantId)) {
            throw new Error("The proposed Shopify SKU belongs to another variant.");
        }
        variantUrl = result.next;
    }
    if (variantUrl) throw new Error("Shopify variant pagination exceeded the safety limit.");
    const imports = await client.query(
        "select external_order_id from store_order_imports where integration_id=$1 and external_order_id=any($2::text[])",
        [INTEGRATION_ID, allowedOrders.map((order) => String(order.id))]
    );
    const importedIds = new Set(imports.rows.map((row) => row.external_order_id));
    const pendingOrders = allowedOrders.filter((order) => !importedIds.has(String(order.id))
        && (order.line_items || []).some((line) => String(line.variant_id) === variantId
            && !String(line.sku || "").trim()
            && Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) > 0));
    if (pendingOrders.some((order) => (order.line_items || []).filter((line) =>
        Number(line.fulfillable_quantity ?? line.current_quantity ?? line.quantity) > 0
    ).some((line) => String(line.variant_id) !== variantId || String(line.sku || "").trim()))) {
        throw new Error("A pending preorder contains another shippable line; manual review is required.");
    }
    return { variantId, productId, candidateLines: candidates.length,
        variantSku: String(variant.sku || ""), pendingOrders };
}

async function readDatabaseScope(client) {
    const integration = await client.query(
        "select * from store_integrations where id=$1 and account_name=$2 and store_identifier=$3 and provider='SHOPIFY' and is_active=true",
        [INTEGRATION_ID, ACCOUNT, STORE]
    );
    if (integration.rowCount !== 1) throw new Error("Shopify integration identity mismatch.");
    const row = integration.rows[0];
    const settings = sanitizeStoreIntegrationSettingsInput("SHOPIFY", row.settings || {});
    if (!settings.syncOrders || settings.syncInventory || row.import_status !== "RELEASED" || row.sync_schedule !== "EVERY_5_MINUTES") {
        throw new Error("Shopify sync settings changed; review before linking preorder stock.");
    }
    const owner = await client.query("select 1 from owner_accounts where id=$1 and name=$2 and is_active=true", [OWNER_ID, ACCOUNT]);
    if (owner.rowCount !== 1) throw new Error("Owner account identity mismatch.");
    const item = await client.query(
        "select sku,blocked,tracking_level,unit_uom,units_per_case from item_catalog where account_name=$1 and sku=$2",
        [ACCOUNT, LOCAL_SKU]
    );
    if (item.rowCount !== 1 || item.rows[0].blocked || item.rows[0].tracking_level !== "UNIT"
        || item.rows[0].unit_uom !== "EA" || Number(item.rows[0].units_per_case) !== PACK_SIZE) {
        throw new Error("The Salt & Vinegar single-bag WMS item is not configured as expected.");
    }
    const mappings = await client.query(
        "select external_sku,account_name,local_sku,local_quantity_multiplier from store_sku_mappings where integration_id=$1 and external_sku=$2",
        [INTEGRATION_ID, EXTERNAL_SKU]
    );
    if (mappings.rows.some((mapping) => mapping.account_name !== ACCOUNT
        || mapping.local_sku !== LOCAL_SKU || Number(mapping.local_quantity_multiplier) !== PACK_SIZE)) {
        throw new Error("The proposed SKU mapping conflicts with an existing mapping.");
    }
    return { integration: decryptStoreIntegrationRow(row), settings, mappings: mappings.rows };
}

async function updateShopifyVariant(integration, variantId) {
    const response = await fetch(`https://${STORE}/admin/api/2026-01/variants/${variantId}.json`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Shopify-Access-Token": integration.access_token },
        body: JSON.stringify({ variant: { id: Number(variantId), sku: EXTERNAL_SKU } }),
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Shopify variant SKU update failed (${response.status}).`);
    const result = await response.json();
    if (String(result.variant?.id) !== variantId || result.variant?.sku !== EXTERNAL_SKU) {
        throw new Error("Shopify did not confirm the exact variant SKU update.");
    }
}

async function main() {
    const preflight = process.argv.includes("--preflight");
    const apply = process.argv.includes("--apply");
    if (preflight === apply) throw new Error("Specify exactly one mode: --preflight or --apply.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database credentials are unavailable.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    let claim;
    let priorStatus;
    let priorMessage;
    try {
        let db = await readDatabaseScope(client);
        let shopify = await readShopifyScope(client, db.integration, db.settings);
        console.log(JSON.stringify({ step: "preflight", candidateLines: shopify.candidateLines,
            wmsSku: LOCAL_SKU, shopifySku: EXTERNAL_SKU, unitsPerShopifyItem: PACK_SIZE,
            mappingCount: db.mappings.length, variantSkuSet: shopify.variantSku === EXTERNAL_SKU,
            pendingHistoricalOrders: shopify.pendingOrders.length,
            inventorySyncEnabled: db.settings.syncInventory }));
        if (!apply) return;
        if (db.mappings.length && shopify.variantSku === EXTERNAL_SKU && !shopify.pendingOrders.length) return;
        if (db.integration.sync_claimed_at) throw new Error("LIVE_SYNC_BUSY: retry after the current sync finishes.");

        priorStatus = db.integration.last_sync_status;
        priorMessage = db.integration.last_sync_message;
        claim = await claimStoreIntegrationSync(client, INTEGRATION_ID);
        if (!claim) throw new Error("LIVE_SYNC_BUSY: the current sync claimed the integration.");
        db = await readDatabaseScope(client);
        shopify = await readShopifyScope(client, db.integration, db.settings);

        let insertedMapping = false;
        if (!db.mappings.length) {
            const result = await client.query(
                `insert into store_sku_mappings
                    (account_name,integration_id,local_sku,external_sku,local_quantity_multiplier,note)
                 values ($1,$2,$3,$4,$5,$6)
                 on conflict (integration_id,external_sku) do nothing returning id`,
                [ACCOUNT, INTEGRATION_ID, LOCAL_SKU, EXTERNAL_SKU, PACK_SIZE,
                    "Shopify Salt & Vinegar preorder 12 Pack; maps to 12 single bags"]
            );
            if (result.rowCount !== 1) throw new Error("SKU mapping changed concurrently; stop for review.");
            insertedMapping = true;
        }

        try {
            if (shopify.variantSku !== EXTERNAL_SKU) await updateShopifyVariant(db.integration, shopify.variantId);
        } catch (error) {
            if (insertedMapping) await client.query(
                "delete from store_sku_mappings where integration_id=$1 and external_sku=$2 and local_sku=$3 and local_quantity_multiplier=$4",
                [INTEGRATION_ID, EXTERNAL_SKU, LOCAL_SKU, PACK_SIZE]
            );
            throw error;
        }

        const finalDb = await readDatabaseScope(client);
        const finalShopify = await shopifyGet(finalDb.integration, `/variants/${shopify.variantId}.json`);
        if (!finalDb.mappings.length || finalShopify.body.variant?.sku !== EXTERNAL_SKU
            || finalShopify.body.variant?.inventory_policy !== "continue") {
            throw new Error("Post-write verification failed; review the mapping and Shopify variant before retrying.");
        }
        let importedDrafts = 0;
        if (shopify.pendingOrders.length) {
            await client.query("begin");
            try {
                const locked = await client.query(
                    "select 1 from store_integrations where id=$1 and sync_claim_token=$2 for update",
                    [INTEGRATION_ID, claim.token]
                );
                if (locked.rowCount !== 1) throw new Error("Integration claim changed during import.");
                const mapping = new Map([[EXTERNAL_SKU, {
                    localSku: LOCAL_SKU,
                    localQuantityMultiplier: PACK_SIZE
                }]]);
                for (const order of shopify.pendingOrders) {
                    const externalOrderId = String(order.id);
                    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
                        [`store-order:${INTEGRATION_ID}:${externalOrderId}`]);
                    const existing = await client.query(
                        "select 1 from store_order_imports where integration_id=$1 and external_order_id=$2",
                        [INTEGRATION_ID, externalOrderId]
                    );
                    if (existing.rowCount) continue;
                    const patchedOrder = {
                        ...order,
                        line_items: order.line_items.map((line) => String(line.variant_id) === shopify.variantId
                            && !String(line.sku || "").trim() ? { ...line, sku: EXTERNAL_SKU } : line)
                    };
                    const payload = applyStoreSkuMappingsToPortalOrderPayload(
                        mapShopifyOrderToPortalDraft(ACCOUNT, patchedOrder, finalDb.integration), mapping
                    );
                    const saved = await savePortalOrderDraftForAccount(client, ACCOUNT, payload, null, {
                        portalAccessId: null,
                        downloadPathPrefix: "/api/admin/portal-order-documents",
                        activityTitlePrefix: "store import",
                        activityActor: "Shopify Salt & Vinegar preorder mapping",
                        enforceInventoryAvailability: false
                    });
                    if (saved.status !== "DRAFT") throw new Error("Historical preorder was not saved as draft.");
                    const inserted = await client.query(
                        `insert into store_order_imports (integration_id,external_order_id,portal_order_id)
                         values ($1,$2,$3) on conflict (integration_id,external_order_id) do nothing returning id`,
                        [INTEGRATION_ID, externalOrderId, saved.id]
                    );
                    if (inserted.rowCount !== 1) throw new Error("Historical preorder import raced another writer.");
                    await client.query(
                        `insert into shopify_tracking_order_contacts
                            (integration_id,order_id,account_name,external_order_id,recipient_email,shopify_order_number)
                         values ($1,$2,$3,$4,$5,$6)
                         on conflict (integration_id,order_id) do update
                         set recipient_email=excluded.recipient_email,
                             shopify_order_number=excluded.shopify_order_number,updated_at=now()`,
                        [INTEGRATION_ID, saved.id, ACCOUNT, externalOrderId,
                            String(order.email || order.contact_email || "").trim().toLowerCase(),
                            String(order.name || "").trim()]
                    );
                    importedDrafts += 1;
                }
                await client.query("commit");
            } catch (_error) {
                await client.query("rollback");
                throw new Error("Historical preorder import failed and was rolled back; review the deployed workflow.");
            }
        }
        await client.query(
            "insert into activity_log (type,title,details) values ('setup',$1,$2)",
            [`Linked Shopify Salt & Vinegar preorder for ${ACCOUNT}`,
                `${EXTERNAL_SKU} -> ${LOCAL_SKU} x ${PACK_SIZE}; inventory sync and preorder policy unchanged`]
        );
        console.log(JSON.stringify({ step: "verified", mapped: true, shopifyVariantSkuSet: true,
            unitsPerShopifyItem: PACK_SIZE, inventoryPolicyUnchanged: true, importedDrafts }));
    } finally {
        try {
            if (claim?.token) {
                try {
                    await client.query(
                        "update store_integrations set last_sync_status=$2,last_sync_message=$3 where id=$1 and sync_claim_token=$4",
                        [INTEGRATION_ID, priorStatus, priorMessage, claim.token]
                    );
                } finally {
                    await releaseStoreIntegrationSyncClaim(client, INTEGRATION_ID, claim.token);
                }
            }
        } finally {
            await client.end();
        }
    }
}

main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
});
