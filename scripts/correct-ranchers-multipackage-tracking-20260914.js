const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const {
    buildCarrierTrackingUrl,
    decryptStoreIntegrationRow,
    fetchShopifyOrderFulfillmentsForIntegration,
    getPortalOrderById,
    sendStoreShipmentConfirmationsForPortalOrder
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const WAREHOUSE_CODE = "GW3PL-MISS";
const EXPECTED_SOURCE_SHA256 = "4518b979e6a5363f1ade48fed4968f15c7b188fa9e910bf3b5bc45f874c55c70";
const SOURCE_WORKBOOK = path.resolve(process.env.RANCHERS_FREIGHT_WORKBOOK
    || "C:/Users/T470/Desktop/Ranchers_Freight_Invoices_and_Tracking_2026-09-14 (1).xlsx");
const SOURCE_JSON = path.resolve(process.env.RANCHERS_FREIGHT_SOURCE
    || "outputs/ranchers-freight-workbook-20260914.json");
const OUTPUT_PATH = path.resolve(process.env.RANCHERS_FREIGHT_CORRECTION_OUTPUT
    || "outputs/ranchers-freight-workbook-correction-20260914.json");
const APPLY_LIVE = String(process.env.APPLY_LIVE || "").toLowerCase() === "true"
    || process.argv.includes("--apply-live");
const TARGET_ORDER_CODES = ["ORD-000689", "ORD-000840"];

const CARRIER_METADATA = Object.freeze({
    CANPAR: { key: "CANPAR", name: "Canpar", slug: "canpar" },
    GLS: { key: "GLS", name: "GLS", slug: "gls" }
});

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function normalizeTracking(value) {
    return clean(value).toUpperCase().replace(/\s+/g, "");
}

function sameSet(left, right) {
    const a = [...new Set(left.map(normalizeTracking).filter(Boolean))].sort();
    const b = [...new Set(right.map(normalizeTracking).filter(Boolean))].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sourceSha256() {
    return crypto.createHash("sha256").update(fs.readFileSync(SOURCE_WORKBOOK)).digest("hex");
}

function carrierMetadata(value) {
    const normalized = clean(value).toUpperCase();
    if (normalized.includes("CANPAR")) return CARRIER_METADATA.CANPAR;
    if (normalized.includes("GLS")) return CARRIER_METADATA.GLS;
    throw new Error(`Unsupported carrier in correction source: ${value || "blank"}`);
}

function getSourceTargets() {
    const source = JSON.parse(fs.readFileSync(SOURCE_JSON, "utf8"));
    if (source?.source?.sha256 !== EXPECTED_SOURCE_SHA256) {
        throw new Error("Extracted workbook data does not match the approved source checksum.");
    }
    const targets = (Array.isArray(source.orders) ? source.orders : [])
        .filter((order) => TARGET_ORDER_CODES.includes(order.orderCode));
    if (targets.length !== TARGET_ORDER_CODES.length
        || !TARGET_ORDER_CODES.every((code) => targets.some((order) => order.orderCode === code))) {
        throw new Error("The extracted workbook is missing one or more approved correction orders.");
    }
    return targets;
}

function shopifyTrackingNumbers(fulfillments) {
    return [...new Set((Array.isArray(fulfillments) ? fulfillments : []).flatMap((fulfillment) => [
        fulfillment?.tracking_number,
        ...(Array.isArray(fulfillment?.tracking_numbers) ? fulfillment.tracking_numbers : [])
    ]).map(normalizeTracking).filter(Boolean))];
}

async function loadAndValidateOrder(client, sourceOrder, { lock = false } = {}) {
    const orderResult = await client.query(
        `select o.*, fl.code warehouse_code
         from portal_orders o
         join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.order_code=$1 and o.account_name=$2
         ${lock ? "for update of o" : ""}`,
        [sourceOrder.orderCode, ACCOUNT]
    );
    if (orderResult.rowCount !== 1) throw new Error(`${sourceOrder.orderCode}: expected one Rancher's order.`);
    const order = orderResult.rows[0];
    if (order.status !== "SHIPPED") throw new Error(`${sourceOrder.orderCode}: status changed to ${order.status}; correction stopped.`);
    if (order.warehouse_code !== WAREHOUSE_CODE) throw new Error(`${sourceOrder.orderCode}: warehouse changed to ${order.warehouse_code}; correction stopped.`);
    if (order.shipment_method !== "PARCEL") throw new Error(`${sourceOrder.orderCode}: shipment method is ${order.shipment_method}; correction stopped.`);

    const shipmentResult = await client.query(
        `select * from warehouse_shipments where order_id=$1 and account_name=$2 ${lock ? "for update" : ""}`,
        [order.id, ACCOUNT]
    );
    if (shipmentResult.rowCount !== 1) throw new Error(`${sourceOrder.orderCode}: expected exactly one warehouse shipment.`);
    const shipment = shipmentResult.rows[0];
    if (shipment.status !== "SHIPPED") throw new Error(`${sourceOrder.orderCode}: warehouse shipment is not shipped.`);
    if (String(shipment.fulfillment_location_id) !== String(order.fulfillment_location_id)) {
        throw new Error(`${sourceOrder.orderCode}: shipment warehouse does not match the order warehouse.`);
    }

    const quantities = await client.query(
        `select l.id,l.requested_quantity,coalesce(sum(sl.shipped_quantity),0)::integer shipped_quantity
         from portal_order_lines l
         left join portal_order_shipment_lines sl on sl.order_line_id=l.id
         where l.order_id=$1
         group by l.id,l.requested_quantity`,
        [order.id]
    );
    if (!quantities.rowCount || quantities.rows.some((line) => Number(line.requested_quantity) !== Number(line.shipped_quantity))) {
        throw new Error(`${sourceOrder.orderCode}: shipped quantities do not match ordered quantities.`);
    }

    const importResult = await client.query(
        `select soi.external_order_id,si.*
         from store_order_imports soi
         join store_integrations si on si.id=soi.integration_id
         where soi.portal_order_id=$1 and si.account_name=$2 and si.provider='SHOPIFY'`,
        [order.id, ACCOUNT]
    );
    if (importResult.rowCount !== 1 || importResult.rows[0].is_active !== true) {
        throw new Error(`${sourceOrder.orderCode}: expected one active Rancher's Shopify import.`);
    }

    return { order, shipment, integration: decryptStoreIntegrationRow(importResult.rows[0]) };
}

async function applyWmsTrackingCorrection(client, sourceOrder) {
    const context = await loadAndValidateOrder(client, sourceOrder, { lock: true });
    const trackingReference = sourceOrder.packages.map((pkg) => normalizeTracking(pkg.tracking)).join("\n");

    await client.query(
        `update portal_orders
         set shipped_tracking_reference=$2, updated_at=now()
         where id=$1`,
        [context.order.id, trackingReference]
    );
    await client.query(
        `update warehouse_shipments
         set tracking_reference=$2, updated_at=now()
         where id=$1`,
        [context.shipment.id, trackingReference]
    );

    const trackerIds = [];
    for (const pkg of sourceOrder.packages) {
        const trackingNumber = normalizeTracking(pkg.tracking);
        const carrier = carrierMetadata(pkg.carrier);
        const trackingUrl = buildCarrierTrackingUrl(carrier.name, trackingNumber);
        if (!trackingUrl) throw new Error(`${sourceOrder.orderCode}: no tracking URL for ${carrier.name} ${trackingNumber}.`);
        const trackerResult = await client.query(
            `insert into shipment_trackers (
                warehouse_shipment_id,order_id,account_name,fulfillment_location_id,
                provider_key,carrier_key,carrier_name,carrier_slug,tracking_number,
                tracking_url,status,next_poll_at
             ) values ($1,$2,$3,$4,'AFTERSHIP',$5,$6,$7,$8,$9,'PENDING',now())
             on conflict (warehouse_shipment_id,tracking_number) do update set
                carrier_key=excluded.carrier_key,
                carrier_name=excluded.carrier_name,
                carrier_slug=excluded.carrier_slug,
                tracking_url=excluded.tracking_url,
                is_active=true,
                updated_at=now()
             returning id`,
            [context.shipment.id, context.order.id, ACCOUNT, context.order.fulfillment_location_id,
                carrier.key, carrier.name, carrier.slug, trackingNumber, trackingUrl]
        );
        trackerIds.push(trackerResult.rows[0].id);
    }
    await client.query(
        `update shipment_trackers
         set is_active=false,next_poll_at=null,updated_at=now()
         where warehouse_shipment_id=$1 and not (id=any($2::bigint[]))`,
        [context.shipment.id, trackerIds]
    );
    await client.query(
        `insert into activity_log (type,title,details)
         values ('order',$1,$2)`,
        [
            `Corrected multi-package tracking for ${sourceOrder.orderCode}`,
            `${ACCOUNT} | ${sourceOrder.packageCount} package tracking numbers | Source workbook SHA256 ${EXPECTED_SOURCE_SHA256}`
        ]
    );
    return context;
}

async function verifyOne(client, sourceOrder) {
    const context = await loadAndValidateOrder(client, sourceOrder);
    const expected = sourceOrder.packages.map((pkg) => pkg.tracking);
    const orderTracking = clean(context.order.shipped_tracking_reference).split(/[\n,;|]+/).filter(Boolean);
    const shipmentTracking = clean(context.shipment.tracking_reference).split(/[\n,;|]+/).filter(Boolean);
    const trackersResult = await client.query(
        `select carrier_name,tracking_number,tracking_url,is_active
         from shipment_trackers where warehouse_shipment_id=$1 order by id`,
        [context.shipment.id]
    );
    const activeTrackers = trackersResult.rows.filter((row) => row.is_active === true);
    const expectedCarrierByTracking = new Map(sourceOrder.packages
        .map((pkg) => [normalizeTracking(pkg.tracking), carrierMetadata(pkg.carrier).name]));
    const carrierMismatch = activeTrackers.some((tracker) => (
        expectedCarrierByTracking.get(normalizeTracking(tracker.tracking_number)) !== tracker.carrier_name
    ));
    const shopifyResult = await fetchShopifyOrderFulfillmentsForIntegration(
        context.integration,
        context.integration.external_order_id
    );
    const shopifyTracking = shopifyTrackingNumbers(shopifyResult.fulfillments);
    return {
        orderCode: sourceOrder.orderCode,
        status: context.order.status,
        packageCount: sourceOrder.packageCount,
        wmsOrderTrackingExact: sameSet(expected, orderTracking),
        wmsShipmentTrackingExact: sameSet(expected, shipmentTracking),
        activeTrackerCount: activeTrackers.length,
        packageCarriersExact: !carrierMismatch && sameSet(expected, activeTrackers.map((row) => row.tracking_number)),
        shopifyFulfillmentCount: shopifyResult.fulfillments.filter((row) => clean(row.status).toUpperCase() !== "CANCELLED").length,
        shopifyTrackingExact: sameSet(expected, shopifyTracking),
        shopifyTrackingCount: shopifyTracking.length
    };
}

async function main() {
    const actualSha = sourceSha256();
    if (actualSha !== EXPECTED_SOURCE_SHA256) {
        throw new Error(`Workbook checksum changed. Expected ${EXPECTED_SOURCE_SHA256}, received ${actualSha}.`);
    }
    const targets = getSourceTargets();
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    const result = {
        runAt: new Date().toISOString(),
        mode: APPLY_LIVE ? "LIVE_CORRECTION" : "DRY_RUN",
        sourceWorkbook: SOURCE_WORKBOOK,
        sourceSha256: actualSha,
        targetOrders: TARGET_ORDER_CODES,
        corrections: [],
        verification: []
    };
    try {
        if (!APPLY_LIVE) {
            await client.query("begin transaction read only");
            for (const target of targets) {
                const context = await loadAndValidateOrder(client, target);
                result.corrections.push({
                    orderCode: target.orderCode,
                    currentStatus: context.order.status,
                    packageCount: target.packageCount,
                    action: "Would correct WMS package tracking and update the existing Shopify fulfillment only."
                });
            }
            await client.query("rollback");
        } else {
            for (const target of targets) {
                await client.query("begin");
                try {
                    await applyWmsTrackingCorrection(client, target);
                    await client.query("commit");
                } catch (error) {
                    await client.query("rollback");
                    throw error;
                }

                const latestOrderResult = await client.query(
                    "select id from portal_orders where order_code=$1 and account_name=$2",
                    [target.orderCode, ACCOUNT]
                );
                const latestOrder = await getPortalOrderById(client, latestOrderResult.rows[0].id, ACCOUNT);
                await sendStoreShipmentConfirmationsForPortalOrder(latestOrder, {}, { isUpdate: true });
                result.corrections.push({
                    orderCode: target.orderCode,
                    status: latestOrder.status,
                    packageCount: target.packageCount,
                    inventoryStatusReplayed: false,
                    customerNotified: false,
                    action: "Corrected existing WMS shipment tracking and updated the existing Shopify fulfillment."
                });
            }
            for (const target of targets) result.verification.push(await verifyOne(client, target));
            if (result.verification.some((row) => !row.wmsOrderTrackingExact
                || !row.wmsShipmentTrackingExact
                || !row.packageCarriersExact
                || !row.shopifyTrackingExact
                || row.shopifyFulfillmentCount !== 1)) {
                throw new Error("Post-correction verification failed. Review the output before any further action.");
            }
        }
    } finally {
        await client.end();
    }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
