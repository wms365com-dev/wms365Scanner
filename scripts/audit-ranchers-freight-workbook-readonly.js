const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const WAREHOUSE_CODE = "GW3PL-MISS";
const SOURCE_PATH = path.resolve(process.env.RANCHERS_FREIGHT_SOURCE || "outputs/ranchers-freight-workbook-20260914.json");
const OUTPUT_PATH = path.resolve(process.env.RANCHERS_FREIGHT_AUDIT_OUTPUT || "outputs/ranchers-freight-workbook-audit-20260914.json");

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function trackingTokens(value) {
    return clean(value)
        .split(/[\s,;]+/)
        .map((token) => token.toUpperCase().replace(/\s+/g, ""))
        .filter(Boolean);
}

function sameSet(left, right) {
    const a = [...new Set(left)].sort();
    const b = [...new Set(right)].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function carrierFamily(value) {
    const normalized = clean(value).toUpperCase();
    for (const carrier of ["CANPAR", "PUROLATOR", "UPS", "GLS", "ICS"]) {
        if (normalized.includes(carrier)) return carrier;
    }
    return normalized;
}

function groupBy(rows, key) {
    const grouped = new Map();
    for (const row of rows) {
        const value = String(row[key]);
        if (!grouped.has(value)) grouped.set(value, []);
        grouped.get(value).push(row);
    }
    return grouped;
}

async function main() {
    const source = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8"));
    const sourceOrders = Array.isArray(source.orders) ? source.orders : [];
    const orderCodes = sourceOrders.map((order) => order.orderCode);
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const [ordersResult, linesResult, shipmentsResult, importsResult, exportsResult, trackersResult] = await Promise.all([
            client.query(
                `select o.id,o.order_code,o.account_name,o.status,o.shipment_method,o.shipped_carrier_name,
                        o.shipped_tracking_reference,o.confirmed_ship_date,o.shipped_at,
                        fl.code warehouse_code
                 from portal_orders o
                 left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
                 where o.order_code=any($1::text[])
                 order by o.order_code`,
                [orderCodes]
            ),
            client.query(
                `select o.order_code,l.id,l.sku,l.requested_quantity,
                        coalesce(sum(psl.shipped_quantity),0)::integer shipped_quantity
                 from portal_orders o
                 join portal_order_lines l on l.order_id=o.id
                 left join portal_order_shipment_lines psl on psl.order_line_id=l.id
                 where o.account_name=$1 and o.order_code=any($2::text[])
                 group by o.order_code,l.id,l.sku,l.requested_quantity,l.line_number
                 order by o.order_code,l.line_number,l.id`,
                [ACCOUNT, orderCodes]
            ),
            client.query(
                `select o.order_code,ws.id,ws.status,ws.shipment_method,ws.carrier_name,ws.tracking_reference,
                        fl.code warehouse_code
                 from portal_orders o
                 join warehouse_shipments ws on ws.order_id=o.id
                 left join fulfillment_locations fl on fl.id=ws.fulfillment_location_id
                 where o.account_name=$1 and o.order_code=any($2::text[])
                 order by o.order_code,ws.id`,
                [ACCOUNT, orderCodes]
            ),
            client.query(
                `select o.order_code,soi.external_order_id,si.id integration_id,si.provider,
                        si.account_name integration_account_name,si.is_active,si.store_identifier
                 from portal_orders o
                 join store_order_imports soi on soi.portal_order_id=o.id
                 join store_integrations si on si.id=soi.integration_id
                 where o.account_name=$1 and o.order_code=any($2::text[])
                 order by o.order_code,si.id`,
                [ACCOUNT, orderCodes]
            ),
            client.query(
                `select o.order_code,se.id,se.entity_type,se.entity_ref,se.remote_path,se.created_at
                 from portal_orders o
                 join store_order_imports soi on soi.portal_order_id=o.id
                 join store_sync_exports se on se.integration_id=soi.integration_id and se.entity_ref=o.id::text
                 where o.account_name=$1 and o.order_code=any($2::text[])
                   and se.entity_type='SHOPIFY_FULFILLMENT'
                 order by o.order_code,se.created_at`,
                [ACCOUNT, orderCodes]
            ),
            client.query(
                `select o.order_code,st.tracking_number,st.carrier_name,st.status,st.tracking_url
                 from portal_orders o
                 join shipment_trackers st on st.order_id=o.id
                 where o.account_name=$1 and o.order_code=any($2::text[]) and st.is_active=true
                 order by o.order_code,st.id`,
                [ACCOUNT, orderCodes]
            )
        ]);

        const ordersByCode = groupBy(ordersResult.rows, "order_code");
        const linesByCode = groupBy(linesResult.rows, "order_code");
        const shipmentsByCode = groupBy(shipmentsResult.rows, "order_code");
        const importsByCode = groupBy(importsResult.rows, "order_code");
        const exportsByCode = groupBy(exportsResult.rows, "order_code");
        const trackersByCode = groupBy(trackersResult.rows, "order_code");

        const audits = sourceOrders.map((sourceOrder) => {
            const code = sourceOrder.orderCode;
            const allOrderMatches = ordersByCode.get(code) || [];
            const accountOrders = allOrderMatches.filter((row) => row.account_name === ACCOUNT);
            const order = accountOrders.length === 1 ? accountOrders[0] : null;
            const lines = linesByCode.get(code) || [];
            const shipments = shipmentsByCode.get(code) || [];
            const imports = importsByCode.get(code) || [];
            const exports = exportsByCode.get(code) || [];
            const trackers = trackersByCode.get(code) || [];
            const sourceTracking = sourceOrder.trackingNumbers || [];
            const wmsTracking = trackingTokens(order?.shipped_tracking_reference || "");
            const trackerTracking = trackers.map((row) => clean(row.tracking_number).toUpperCase()).filter(Boolean);
            const issues = [];
            if (accountOrders.length !== 1) issues.push(accountOrders.length ? "duplicate Rancher's order code" : "order not found under Rancher's Chips");
            if (allOrderMatches.some((row) => row.account_name !== ACCOUNT)) issues.push("same order code also exists under another customer");
            if (order && order.warehouse_code !== WAREHOUSE_CODE) issues.push(`wrong warehouse ${order.warehouse_code || "blank"}`);
            if (order && order.status !== "SHIPPED") issues.push(`requires WMS workflow from ${order.status}`);
            if (order && order.shipment_method !== "PARCEL") issues.push(`shipment method is ${order.shipment_method || "blank"}, not PARCEL`);
            if (order && !sameSet(sourceTracking, wmsTracking)) issues.push("WMS tracking numbers do not exactly match the workbook");
            if (sourceOrder.carriers.length === 1 && order
                && carrierFamily(order.shipped_carrier_name) !== carrierFamily(sourceOrder.carriers[0])) {
                issues.push(`WMS carrier ${order.shipped_carrier_name || "blank"} does not match ${sourceOrder.carriers[0]}`);
            }
            if (!lines.length) issues.push("order has no lines");
            if (order && lines.some((line) => Number(line.shipped_quantity) !== Number(line.requested_quantity))) issues.push("shipped line quantity does not match ordered quantity");
            if (shipments.length !== 1) issues.push(`expected one warehouse shipment, found ${shipments.length}`);
            if (shipments.some((shipment) => shipment.status !== "SHIPPED")) issues.push("warehouse shipment is not shipped");
            if (imports.length !== 1) issues.push(`expected one Shopify import link, found ${imports.length}`);
            if (imports.some((entry) => entry.provider !== "SHOPIFY" || entry.integration_account_name !== ACCOUNT || entry.is_active !== true)) {
                issues.push("Shopify integration is inactive or belongs to another customer");
            }
            if (!exports.length) issues.push("Shopify fulfillment export is not recorded");
            if (!sameSet(sourceTracking, trackerTracking)) issues.push("shipment tracker records do not cover every workbook tracking number");
            return {
                orderCode: code,
                status: order?.status || "NOT_FOUND",
                sourceCarriers: sourceOrder.carriers,
                wmsCarrier: order?.shipped_carrier_name || "",
                sourceTrackingCount: sourceTracking.length,
                wmsTrackingCount: wmsTracking.length,
                trackerCount: trackerTracking.length,
                shopifyExternalOrderId: imports[0]?.external_order_id || "",
                shopifyExportCount: exports.length,
                confirmedShipDate: order?.confirmed_ship_date || null,
                issues
            };
        });

        const output = {
            auditedAt: new Date().toISOString(),
            mode: "READ_ONLY",
            source: source.source,
            packageRows: source.packageRows,
            orderCount: source.orderCount,
            summary: {
                exactMatches: audits.filter((row) => row.issues.length === 0).length,
                exceptions: audits.filter((row) => row.issues.length > 0).length,
                shipped: audits.filter((row) => row.status === "SHIPPED").length,
                shopifyExportRecorded: audits.filter((row) => row.shopifyExportCount > 0).length,
                exactTracking: audits.filter((row) => row.sourceTrackingCount === row.wmsTrackingCount && !row.issues.includes("WMS tracking numbers do not exactly match the workbook")).length,
            },
            exceptions: audits.filter((row) => row.issues.length > 0),
            audits,
        };
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
        console.log(JSON.stringify({ outputPath: OUTPUT_PATH, ...output.summary, exceptionDetails: output.exceptions }, null, 2));
        await client.query("rollback");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
