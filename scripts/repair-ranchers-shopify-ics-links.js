const { Client } = require("pg");
const {
    getPortalOrderById,
    decryptStoreIntegrationRow,
    sendShopifyShipmentConfirmationForImport,
    fetchShopifyOrderFulfillmentsForIntegration,
    selectShopifyFulfillmentForTrackingUpdate
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const EXPECTED_STORE = "f1acxk-dc.myshopify.com";
const EXPECTED_URL_PREFIX = "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    const results = [];
    try {
        const candidateResult = await client.query(
            `select o.id as portal_order_id, o.order_code, o.fulfillment_location_id,
                    soi.external_order_id, si.*,
                    fl.code as warehouse_code
             from portal_orders o
             join store_order_imports soi on soi.portal_order_id = o.id
             join store_integrations si on si.id = soi.integration_id
             join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             where o.account_name = $1
               and o.status = 'SHIPPED'
               and upper(regexp_replace(coalesce(o.shipped_carrier_name, ''), '[^A-Z0-9]', '', 'g')) in ('ICS', 'ICSCOURIER')
             order by o.order_code`,
            [ACCOUNT]
        );

        for (const candidate of candidateResult.rows) {
            const result = { orderCode: candidate.order_code, updated: false, verified: false, error: "" };
            try {
                if (candidate.account_name !== ACCOUNT) throw new Error("Integration owner mismatch.");
                if (candidate.store_identifier !== EXPECTED_STORE) throw new Error("Unexpected Shopify store.");
                if (candidate.warehouse_code !== "GW3PL-MISS") throw new Error("Unexpected fulfillment warehouse.");
                if (candidate.is_active !== true) throw new Error("Shopify integration is inactive.");

                const integration = decryptStoreIntegrationRow(candidate);

                await client.query("begin");
                const order = await getPortalOrderById(client, candidate.portal_order_id, ACCOUNT);
                if (!order || order.status !== "SHIPPED") throw new Error("Order is not a shipped Rancher's order.");
                const syncResult = await sendShopifyShipmentConfirmationForImport(
                    client,
                    integration,
                    order,
                    candidate.external_order_id,
                    {},
                    { isUpdate: true }
                );
                await client.query("commit");
                result.updated = syncResult?.skipped !== true;

                const remote = await fetchShopifyOrderFulfillmentsForIntegration(integration, candidate.external_order_id);
                const fulfillment = selectShopifyFulfillmentForTrackingUpdate(remote.fulfillments, order.shippedTrackingReference);
                const urls = [
                    fulfillment?.tracking_url,
                    ...(Array.isArray(fulfillment?.tracking_urls) ? fulfillment.tracking_urls : [])
                ].filter(Boolean);
                const expectedUrl = `${EXPECTED_URL_PREFIX}${encodeURIComponent(String(order.shippedTrackingReference || "").replace(/\s+/g, ""))}`;
                result.verified = Boolean(
                    fulfillment
                    && String(fulfillment.tracking_company || "").trim() === "ICS Courier"
                    && urls.includes(expectedUrl)
                );
                if (!result.verified) result.error = "Shopify read-back did not contain the expected ICS Courier link.";
            } catch (error) {
                try { await client.query("rollback"); } catch (_rollbackError) {}
                result.error = error.message || String(error);
            }
            results.push(result);
        }

        console.log(JSON.stringify({
            account: ACCOUNT,
            candidateCount: results.length,
            updatedCount: results.filter((entry) => entry.updated).length,
            verifiedCount: results.filter((entry) => entry.verified).length,
            failedCount: results.filter((entry) => !entry.verified).length,
            results
        }, null, 2));
        if (results.some((entry) => !entry.verified)) process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
