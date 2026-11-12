"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { decryptStoreIntegrationRow } = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const OUTPUT = path.resolve(".codex-tmp/ranchers-delivery-status-audit-20260917.json");
const SCAN_SOURCES = ["AFTERSHIP", "CANPAR_BROWSER", "ICS_COURIER_BROWSER", "GLS_BROWSER"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const QUERY = `query DeliveryAudit($ids:[ID!]!) {
  shop { id myshopifyDomain }
  nodes(ids:$ids) { ... on Order { id name fulfillmentsCount { count } fulfillments(first:20) {
    id status displayStatus deliveredAt trackingInfo { company number url }
    events(first:5) { nodes { id status happenedAt } pageInfo { hasNextPage } }
  } } }
}`;

function confirmedDelivery(tracker, events, now = Date.now()) {
    const scans = events.filter((event) => String(event.tracker_id) === String(tracker.id)
        && event.status === "DELIVERED" && SCAN_SOURCES.includes(event.source)
        && event.safe_metadata?.carrier_scan === true
        && Number.isFinite(new Date(event.event_at).getTime()) && new Date(event.event_at).getTime() <= now);
    scans.sort((a, b) => new Date(b.event_at) - new Date(a.event_at));
    return scans[0] || null;
}

async function snapshot() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_CONNECTION_UNAVAILABLE");
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 20000 });
    await client.connect();
    try {
        await client.query("begin transaction isolation level repeatable read read only");
        await client.query("set local statement_timeout='20s'");
        const orders = await client.query(`select o.id,o.order_code,o.status,o.shipped_at,o.shipped_carrier_name,o.shipped_tracking_reference,
            imp.integration_id,imp.external_order_id from portal_orders o
            left join store_order_imports imp on imp.portal_order_id=o.id
            left join store_integrations i on i.id=imp.integration_id and i.account_name=o.account_name and i.provider='SHOPIFY'
            where o.account_name=$1 and o.status='SHIPPED' and (imp.id is null or i.id is not null)
            order by o.order_code`, [ACCOUNT]);
        const integrations = await client.query("select * from store_integrations where account_name=$1 and provider='SHOPIFY'", [ACCOUNT]);
        const trackers = await client.query("select id,order_id,warehouse_shipment_id,fulfillment_location_id,carrier_name,tracking_number,status,delivered_at,last_checked_at,tracking_url,is_active from shipment_trackers where account_name=$1 order by id", [ACCOUNT]);
        const events = await client.query(`select e.id,e.tracker_id,e.status,e.source,e.event_at,e.safe_metadata
            from shipment_tracking_events e join shipment_trackers t on t.id=e.tracker_id
            where t.account_name=$1 and e.status='DELIVERED' order by e.event_at desc`, [ACCOUNT]);
        await client.query("rollback");
        return { orders: orders.rows, integrations: integrations.rows, trackers: trackers.rows, events: events.rows };
    } finally { await client.end(); }
}

async function accessToken(raw) {
    const integration = decryptStoreIntegrationRow(raw);
    const expires = integration.access_token_expires_at ? new Date(integration.access_token_expires_at).getTime() : Infinity;
    if (integration.access_token && expires > Date.now() + 60000) return integration.access_token;
    if (!integration.auth_client_id || !integration.auth_client_secret) throw new Error("SHOPIFY_CREDENTIAL_UNAVAILABLE");
    const response = await fetch(`https://${integration.store_identifier}/admin/oauth/access_token`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ grant_type: "client_credentials", client_id: integration.auth_client_id, client_secret: integration.auth_client_secret })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`SHOPIFY_AUTH_FAILED_${response.status}`);
    // Short-lived credential remains in process memory; never persisted to WMS or output.
    return data.access_token;
}

async function graphql(integration, token, ids) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`https://${integration.store_identifier}/admin/api/2026-07/graphql.json`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
            signal: AbortSignal.timeout(30000), body: JSON.stringify({ query: QUERY, variables: { ids } })
        });
        const payload = await response.json();
        if (response.status === 429 || payload.errors?.some((error) => error.extensions?.code === "THROTTLED")) {
            await delay(1000 * (2 ** attempt)); continue;
        }
        if (!response.ok || payload.errors?.length || !Array.isArray(payload.data?.nodes)) {
            const fields = payload.errors?.map((error) => ({ code: error.extensions?.code || "GRAPHQL_ERROR", message: String(error.message || "").slice(0, 250) }));
            console.log(JSON.stringify({ apiErrors: fields || [], httpStatus: response.status }));
            throw new Error("SHOPIFY_READ_FAILED");
        }
        if (payload.data.shop?.myshopifyDomain !== integration.store_identifier) throw new Error("SHOPIFY_STORE_SCOPE_MISMATCH");
        return payload.data.nodes;
    }
    throw new Error("SHOPIFY_READ_THROTTLED");
}

async function main() {
    const data = await snapshot();
    const deliveredTrackers = data.trackers.filter((tracker) => tracker.status === "DELIVERED");
    const summary = { shippedOrders: new Set(data.orders.map((order) => String(order.id))).size,
        shopifyMatchedOrders: new Set(data.orders.filter((order) => order.integration_id).map((order) => String(order.id))).size,
        trackerCount: data.trackers.length, trackerStatuses: {}, trackerMarkedDelivered: deliveredTrackers.length,
        carrierConfirmedDeliveries: data.trackers.filter((tracker) => confirmedDelivery(tracker, data.events)).length,
        deliveredEventSources: {} };
    for (const tracker of data.trackers) summary.trackerStatuses[tracker.status] = (summary.trackerStatuses[tracker.status] || 0) + 1;
    for (const event of data.events) summary.deliveredEventSources[event.source] = (summary.deliveredEventSources[event.source] || 0) + 1;
    const report = { generatedAt: new Date().toISOString(), mode: "READ_ONLY", accountName: ACCOUNT, summary,
        orders: [], errors: [], trackerEvidence: data.trackers.map((tracker) => ({ ...tracker, confirmedDelivery: confirmedDelivery(tracker, data.events) })) };
    console.log(JSON.stringify({ phase: "WMS_SNAPSHOT", ...summary }));
    if (!process.argv.includes("--snapshot-only")) {
        for (const integration of data.integrations) {
            if (!integration.is_active || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(integration.store_identifier)) continue;
            const rows = data.orders.filter((order) => String(order.integration_id) === String(integration.id));
            let token;
            try { token = await accessToken(integration); }
            catch (error) { report.errors.push({ integrationId: String(integration.id), code: error.message }); continue; }
            for (let start = 0; start < rows.length; start += 5) {
                const batch = rows.slice(start, start + 5);
                const ids = batch.map((order) => `gid://shopify/Order/${String(order.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "")}`);
                try {
                    const remote = await graphql(integration, token, ids);
                    for (let index = 0; index < batch.length; index += 1) {
                        const order = batch[index];
                        const node = remote[index];
                        if (!node || node.id !== ids[index] || !Array.isArray(node.fulfillments)) {
                            report.errors.push({ orderCode: order.order_code, code: "SHOPIFY_ORDER_UNAVAILABLE" }); continue;
                        }
                        if (!Number.isInteger(node.fulfillmentsCount?.count) || node.fulfillmentsCount.count > node.fulfillments.length) {
                            report.errors.push({ orderCode: order.order_code, code: "SHOPIFY_FULFILLMENTS_TRUNCATED" }); continue;
                        }
                        const trackers = data.trackers.filter((tracker) => String(tracker.order_id) === String(order.id));
                        const fulfillments = node.fulfillments.filter((f) => f.status !== "CANCELLED").map((f) => {
                            const packages = f.trackingInfo.map((item) => ({ ...item,
                                matchingTrackers: trackers.filter((tracker) => tracker.tracking_number === item.number)
                                    .map((tracker) => ({ trackerId: String(tracker.id), carrierConfirmedDelivery: confirmedDelivery(tracker, data.events) })) }));
                            const allPackagesConfirmed = packages.length > 0 && packages.every((p) => p.matchingTrackers.length === 1 && p.matchingTrackers[0].carrierConfirmedDelivery);
                            const delivered = f.displayStatus === "DELIVERED" || Boolean(f.deliveredAt);
                            return { ...f, packages, allPackagesConfirmed, deliveryMismatch: Boolean(allPackagesConfirmed && !delivered) };
                        });
                        report.orders.push({ orderCode: order.order_code, shopifyOrderNumber: node.name,
                            externalOrderId: order.external_order_id, integrationId: String(integration.id), fulfillments });
                    }
                } catch (error) { report.errors.push({ integrationId: String(integration.id), batchStart: start, code: error.message }); }
                console.log(JSON.stringify({ phase: "SHOPIFY_READ", processed: Math.min(start + 5, rows.length), total: rows.length }));
                await delay(750);
            }
        }
    }
    summary.shopifyAuditedOrders = report.orders.length;
    summary.shopifyFulfillmentStatuses = {};
    for (const order of report.orders) for (const f of order.fulfillments) summary.shopifyFulfillmentStatuses[f.displayStatus] = (summary.shopifyFulfillmentStatuses[f.displayStatus] || 0) + 1;
    summary.confirmedDeliveryMismatchOrders = report.orders.filter((order) => order.fulfillments.some((f) => f.deliveryMismatch)).length;
    summary.readErrors = report.errors.length;
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ phase: "COMPLETE", output: OUTPUT, ...summary, errors: report.errors }));
}

if (require.main === module) main().catch((error) => { console.error(error.code || error.message || "AUDIT_FAILED"); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
module.exports = { confirmedDelivery, QUERY };
