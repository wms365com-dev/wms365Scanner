const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
    buildCarrierTrackingUrl,
    classifyParcelTrackingReference,
    getShipmentMethodTrackingConflict
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const OUTPUT_PATH = path.resolve("outputs/ranchers-tracking-audit/Ranchers_All_Tracking_Audit.json");

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function references(value) {
    return [...new Set(clean(value).split(/[\n,;|]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function expectedUrls(carrier, trackingReference) {
    return references(trackingReference).map((tracking) => ({
        tracking,
        url: buildCarrierTrackingUrl(carrier, tracking)
    }));
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const [ordersResult, shipmentsResult, trackersResult, duplicatesResult] = await Promise.all([
            client.query(
                `select o.id, o.order_code, o.status, o.shipment_method,
                        o.shipped_carrier_name, o.shipped_tracking_reference,
                        fl.code as warehouse_code
                 from portal_orders o
                 left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
                 where o.account_name = $1 and o.status = 'SHIPPED'
                 order by o.order_code`,
                [ACCOUNT]
            ),
            client.query(
                `select ws.order_id, ws.shipment_code, ws.status, ws.shipment_method,
                        ws.carrier_name, ws.tracking_reference, fl.code as warehouse_code
                 from warehouse_shipments ws
                 left join fulfillment_locations fl on fl.id = ws.fulfillment_location_id
                 where ws.account_name = $1
                 order by ws.order_id, ws.id`,
                [ACCOUNT]
            ),
            client.query(
                `select st.order_id, st.warehouse_shipment_id, st.carrier_name,
                        st.tracking_number, st.tracking_url, st.status, st.is_active
                 from shipment_trackers st
                 where st.account_name = $1
                 order by st.order_id, st.id`,
                [ACCOUNT]
            ),
            client.query(
                `select upper(trim(shipped_tracking_reference)) as tracking_reference,
                        count(*)::integer as order_count,
                        array_agg(order_code order by order_code) as order_codes
                 from portal_orders
                 where nullif(trim(shipped_tracking_reference), '') is not null
                 group by upper(trim(shipped_tracking_reference))
                 having count(*) > 1
                 order by count(*) desc, tracking_reference`
            )
        ]);
        await client.query("rollback");

        const shipmentsByOrder = new Map();
        for (const shipment of shipmentsResult.rows) {
            const key = String(shipment.order_id);
            if (!shipmentsByOrder.has(key)) shipmentsByOrder.set(key, []);
            shipmentsByOrder.get(key).push(shipment);
        }
        const trackersByOrder = new Map();
        for (const tracker of trackersResult.rows) {
            const key = String(tracker.order_id);
            if (!trackersByOrder.has(key)) trackersByOrder.set(key, []);
            trackersByOrder.get(key).push(tracker);
        }

        const carrierCounts = {};
        const methodCounts = {};
        const exceptions = [];
        for (const order of ordersResult.rows) {
            const carrier = clean(order.shipped_carrier_name);
            const tracking = clean(order.shipped_tracking_reference);
            const method = clean(order.shipment_method).toUpperCase();
            carrierCounts[carrier || "MISSING"] = (carrierCounts[carrier || "MISSING"] || 0) + 1;
            methodCounts[method || "MISSING"] = (methodCounts[method || "MISSING"] || 0) + 1;
            const issues = [];
            const urls = expectedUrls(carrier, tracking);
            const detected = classifyParcelTrackingReference(tracking, carrier);
            const conflict = getShipmentMethodTrackingConflict({ shipmentMethod: method, carrierName: carrier, trackingReference: tracking });
            if (!carrier) issues.push("Carrier is missing");
            if (!tracking) issues.push("Tracking number is missing");
            if (conflict) issues.push(conflict.message);
            if (tracking && detected.isParcel && urls.some((entry) => !entry.url)) issues.push("Recognized parcel tracking has no generated carrier URL");

            const shipments = shipmentsByOrder.get(String(order.id)) || [];
            const trackers = trackersByOrder.get(String(order.id)) || [];
            if (!shipments.length) issues.push("Warehouse shipment record is missing");
            for (const shipment of shipments) {
                if (clean(shipment.shipment_method).toUpperCase() !== method) issues.push(`${shipment.shipment_code} shipment type does not match the order`);
                if (clean(shipment.carrier_name).toUpperCase() !== carrier.toUpperCase()) issues.push(`${shipment.shipment_code} carrier does not match the order`);
                if (clean(shipment.tracking_reference).toUpperCase() !== tracking.toUpperCase()) issues.push(`${shipment.shipment_code} tracking does not match the order`);
            }
            if (tracking && !trackers.length) issues.push("Shipment tracking record is missing");
            for (const tracker of trackers) {
                const expectedUrl = buildCarrierTrackingUrl(tracker.carrier_name, tracker.tracking_number);
                if (expectedUrl && clean(tracker.tracking_url) !== expectedUrl) issues.push(`Stored tracking URL is stale for ${tracker.tracking_number}`);
            }
            if (issues.length) {
                exceptions.push({
                    orderCode: order.order_code,
                    shipmentMethod: method,
                    carrier,
                    tracking,
                    generatedUrls: urls,
                    issues: [...new Set(issues)]
                });
            }
        }

        const ranchersOrderCodes = new Set(ordersResult.rows.map((row) => row.order_code));
        const duplicateTracking = duplicatesResult.rows
            .filter((row) => (row.order_codes || []).some((code) => ranchersOrderCodes.has(code)))
            .map((row) => ({
                tracking: row.tracking_reference,
                orderCount: row.order_count,
                orderCodes: row.order_codes
            }));
        const report = {
            generatedAt: new Date().toISOString(),
            accountName: ACCOUNT,
            shippedOrders: ordersResult.rowCount,
            ordersWithTracking: ordersResult.rows.filter((row) => clean(row.shipped_tracking_reference)).length,
            ordersWithoutTracking: ordersResult.rows.filter((row) => !clean(row.shipped_tracking_reference)).length,
            carrierCounts,
            methodCounts,
            exceptionCount: exceptions.length,
            duplicateTrackingCount: duplicateTracking.length,
            exceptions,
            duplicateTracking
        };
        fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
        fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
        console.log(JSON.stringify({
            outputPath: OUTPUT_PATH,
            shippedOrders: report.shippedOrders,
            ordersWithTracking: report.ordersWithTracking,
            ordersWithoutTracking: report.ordersWithoutTracking,
            carrierCounts,
            methodCounts,
            exceptionCount: report.exceptionCount,
            duplicateTrackingCount: report.duplicateTrackingCount,
            exceptions
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
