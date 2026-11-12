const { Client } = require("pg");
const { decryptSecret } = require("../server");

const ORDER_CODE = String(process.argv[2] || "").trim().toUpperCase();
const SHOPIFY_API_VERSION = "2026-01";

async function getEphemeralAccessToken(integration) {
    const existing = decryptSecret(integration.access_token || "");
    const expiresAt = integration.access_token_expires_at ? new Date(integration.access_token_expires_at) : null;
    if (existing && (!expiresAt || expiresAt.getTime() > Date.now() + 60000)) return existing;

    const clientId = String(integration.auth_client_id || "").trim();
    const clientSecret = decryptSecret(integration.auth_client_secret || "");
    if (!clientId || !clientSecret) throw new Error("Shopify credentials are unavailable for a read-only lookup.");
    const response = await fetch(`https://${integration.store_identifier}/admin/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret
        }),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
        throw new Error(`Shopify token request failed (${response.status}).`);
    }
    return String(payload.access_token);
}

async function main() {
    if (!/^ORD-\d{6}$/.test(ORDER_CODE)) throw new Error("Provide an order code such as ORD-000750.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        const orderResult = await client.query(
            `select o.id, o.order_code, o.account_name, o.status, o.po_number, o.shipping_reference,
                    o.order_type, o.shipment_method, o.requested_ship_date,
                    o.contact_name, o.contact_phone, o.order_notes,
                    o.ship_to_name, o.ship_to_address1, o.ship_to_address2, o.ship_to_city,
                    o.ship_to_state, o.ship_to_postal_code, o.ship_to_country, o.ship_to_phone,
                    o.fulfillment_location_id, fl.code as warehouse_code, fl.name as warehouse_name,
                    o.created_at, o.released_at, o.picked_at, o.staged_at, o.shipped_at
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             where o.order_code = $1`,
            [ORDER_CODE]
        );
        if (orderResult.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found.`);
        const order = orderResult.rows[0];

        const [lineResult, importResult] = await Promise.all([
            client.query(
                `select l.line_number, l.sku, l.requested_quantity, c.description, c.tracking_level,
                        c.unit_uom, c.units_per_case
                 from portal_order_lines l
                 left join item_catalog c on c.account_name = $2 and c.sku = l.sku
                 where l.order_id = $1 order by l.line_number, l.id`,
                [order.id, order.account_name]
            ),
            client.query(
                `select soi.external_order_id, soi.imported_at, soi.last_seen_at,
                        si.id as integration_id, si.provider, si.integration_name, si.store_identifier,
                        si.import_status, si.is_active, si.settings, si.access_token,
                        si.access_token_expires_at, si.auth_client_id, si.auth_client_secret,
                        si.last_synced_at, si.last_sync_status, si.last_sync_message
                 from store_order_imports soi
                 join store_integrations si on si.id = soi.integration_id
                 where soi.portal_order_id = $1`,
                [order.id]
            )
        ]);

        const imported = importResult.rows[0] || null;
        if (!imported || imported.provider !== "SHOPIFY") {
            console.log(JSON.stringify({ order, lines: lineResult.rows, shopify: null, note: "This order has no Shopify import record." }, null, 2));
            return;
        }

        const mappingsResult = await client.query(
            `select external_sku, local_sku, local_quantity_multiplier, note
             from store_sku_mappings where integration_id = $1 order by external_sku`,
            [imported.integration_id]
        );
        const accessToken = await getEphemeralAccessToken(imported);
        const fields = [
            "id", "name", "order_number", "created_at", "processed_at", "updated_at",
            "email", "phone", "tags", "note", "currency", "subtotal_price", "total_price",
            "total_tax", "total_discounts", "financial_status", "fulfillment_status",
            "cancelled_at", "source_name", "shipping_address", "billing_address", "customer",
            "line_items", "shipping_lines"
        ].join(",");
        const url = new URL(`https://${imported.store_identifier}/admin/api/${SHOPIFY_API_VERSION}/orders/${imported.external_order_id}.json`);
        url.searchParams.set("fields", fields);
        const response = await fetch(url, {
            headers: { Accept: "application/json", "X-Shopify-Access-Token": accessToken },
            signal: AbortSignal.timeout(30000)
        });
        const shopifyPayload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Shopify order lookup failed (${response.status}).`);

        const mappingByExternalSku = new Map(mappingsResult.rows.map((row) => [String(row.external_sku || "").trim().toUpperCase(), row]));
        const shopifyOrder = shopifyPayload.order || null;
        const mappedLineItems = (shopifyOrder?.line_items || []).map((line) => {
            const mapping = mappingByExternalSku.get(String(line.sku || "").trim().toUpperCase());
            const multiplier = Number(mapping?.local_quantity_multiplier || 1);
            return {
                shopifyLineItemId: String(line.id || ""),
                title: line.title || "",
                variantTitle: line.variant_title || "",
                shopifySku: line.sku || "",
                shopifyQuantity: Number(line.quantity || 0),
                price: line.price || "",
                fulfillmentStatus: line.fulfillment_status || "",
                localSku: mapping?.local_sku || line.sku || "",
                wmsUnitsPerShopifyItem: multiplier,
                expectedWmsQuantity: Number(line.quantity || 0) * multiplier
            };
        });

        const safeImport = {
            externalOrderId: imported.external_order_id,
            importedAt: imported.imported_at,
            lastSeenAt: imported.last_seen_at,
            integrationId: String(imported.integration_id),
            integrationName: imported.integration_name,
            shop: imported.store_identifier,
            importStatus: imported.import_status,
            isActive: imported.is_active,
            lastSyncedAt: imported.last_synced_at,
            lastSyncStatus: imported.last_sync_status,
            lastSyncMessage: imported.last_sync_message
        };
        console.log(JSON.stringify({
            order,
            wmsLines: lineResult.rows,
            shopifyImport: safeImport,
            shopifyOrder: shopifyOrder ? { ...shopifyOrder, line_items: mappedLineItems } : null
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
