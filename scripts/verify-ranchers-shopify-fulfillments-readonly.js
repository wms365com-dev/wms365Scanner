const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
    decryptStoreIntegrationRow,
    fetchShopifyOrderFulfillmentsForIntegration
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const SOURCE_PATH = path.resolve(process.env.RANCHERS_FREIGHT_SOURCE || "outputs/ranchers-freight-workbook-20260914.json");
const OUTPUT_PATH = path.resolve(process.env.RANCHERS_SHOPIFY_AUDIT_OUTPUT || "outputs/ranchers-shopify-fulfillment-audit-20260914.json");

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function trackingTokens(value) {
    if (Array.isArray(value)) return value.flatMap(trackingTokens);
    return clean(value)
        .split(/[\s,;]+/)
        .map((token) => token.toUpperCase().replace(/\s+/g, ""))
        .filter(Boolean);
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const source = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8"));
    const sourceByCode = new Map((source.orders || []).map((order) => [order.orderCode, order]));
    const orderCodes = [...sourceByCode.keys()];
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    let rows;
    try {
        await client.query("begin transaction read only");
        const result = await client.query(
            `select o.id portal_order_id,o.order_code,o.status,o.shipped_carrier_name,o.shipped_tracking_reference,
                    soi.external_order_id,si.*
             from portal_orders o
             join store_order_imports soi on soi.portal_order_id=o.id
             join store_integrations si on si.id=soi.integration_id
             where o.account_name=$1 and o.order_code=any($2::text[])
             order by o.order_code`,
            [ACCOUNT, orderCodes]
        );
        rows = result.rows;
        await client.query("rollback");
    } finally {
        await client.end();
    }

    const audits = [];
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const sourceOrder = sourceByCode.get(row.order_code);
        const integration = decryptStoreIntegrationRow(row);
        try {
            const remote = await fetchShopifyOrderFulfillmentsForIntegration(integration, row.external_order_id);
            const fulfillments = (remote.fulfillments || []).filter((entry) => clean(entry.status).toUpperCase() !== "CANCELLED");
            const remoteTracking = unique(fulfillments.flatMap((entry) => trackingTokens([
                entry.tracking_number,
                entry.tracking_numbers
            ])));
            const sourceTracking = unique(sourceOrder?.trackingNumbers || []);
            audits.push({
                orderCode: row.order_code,
                externalOrderId: row.external_order_id,
                wmsStatus: row.status,
                fulfillmentCount: fulfillments.length,
                fulfillmentStatuses: unique(fulfillments.map((entry) => clean(entry.status).toUpperCase())),
                shipmentStatuses: unique(fulfillments.map((entry) => clean(entry.shipment_status).toUpperCase())),
                sourceTrackingCount: sourceTracking.length,
                shopifyTrackingCount: remoteTracking.length,
                missingTrackingInShopify: sourceTracking.filter((tracking) => !remoteTracking.includes(tracking)),
                extraTrackingInShopify: remoteTracking.filter((tracking) => !sourceTracking.includes(tracking)),
                trackingCompanies: unique(fulfillments.map((entry) => clean(entry.tracking_company))),
                error: ""
            });
        } catch (error) {
            audits.push({
                orderCode: row.order_code,
                externalOrderId: row.external_order_id,
                wmsStatus: row.status,
                fulfillmentCount: 0,
                sourceTrackingCount: sourceOrder?.trackingNumbers?.length || 0,
                shopifyTrackingCount: 0,
                missingTrackingInShopify: sourceOrder?.trackingNumbers || [],
                extraTrackingInShopify: [],
                trackingCompanies: [],
                error: error.message || String(error)
            });
        }
        if ((index + 1) % 20 === 0 || index + 1 === rows.length) {
            console.log(JSON.stringify({ progress: index + 1, total: rows.length }));
        }
        await delay(225);
    }

    const missingSourceOrders = orderCodes.filter((code) => !rows.some((row) => row.order_code === code));
    const exceptions = audits.filter((row) => row.error || !row.fulfillmentCount || row.missingTrackingInShopify.length || row.extraTrackingInShopify.length);
    const output = {
        auditedAt: new Date().toISOString(),
        mode: "READ_ONLY",
        source: source.source,
        orderCount: orderCodes.length,
        matchedShopifyImports: rows.length,
        missingSourceOrders,
        summary: {
            fulfilledOrders: audits.filter((row) => row.fulfillmentCount > 0).length,
            exactTrackingOrders: audits.filter((row) => !row.error && row.fulfillmentCount > 0 && !row.missingTrackingInShopify.length && !row.extraTrackingInShopify.length).length,
            exceptions: exceptions.length,
            requestErrors: audits.filter((row) => row.error).length
        },
        exceptions,
        audits
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ outputPath: OUTPUT_PATH, ...output.summary, missingSourceOrders, exceptions }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
