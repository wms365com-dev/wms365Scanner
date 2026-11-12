const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const WAREHOUSE = "GW3PL-MISS";
const SHIP_DATE = "2026-09-15";
const SHOPIFY_EXPORT_TYPE = "SHOPIFY_FULFILLMENT";
const OUTBOUND_FEE_CODES = [
    "SHIPPING_ADMINISTRATION_FEE",
    "ORDER_PROCESSING_FIRST_ITEM",
    "ADDITIONAL_ITEM_PICK"
];
const ROWS = [
    ["ORD-000928", "ICS Standard", "ND6C2BV3PTL450J2L3A2", 6],
    ["ORD-000927", "ICS Standard", "ND6C2BV3PTL4N8P0H1K0", 6],
    ["ORD-000926", "UPS Standard", "1ZV56D262032007556", 12],
    ["ORD-000924", "GLS Ground", "P62139420", 6],
    ["ORD-000923", "ICS Standard", "ND6C2BV3PTL5XML9K0G5", 6],
    ["ORD-000922", "GLS Ground", "P62139431", 12],
    ["ORD-000921", "ICS Ground", "GR6C2BV3PTL6MZT5T4V5", 6],
    ["ORD-000919", "ICS Ground", "GR6C2BV3PTL6ZTC1A3R6", 6],
    ["ORD-000918", "GLS Ground", "P62139475", 6],
    ["ORD-000917", "ICS Ground", "GR6C2BV3PTL7U9T9K0M1", 6],
    ["ORD-000916", "GLS Ground", "P62139836", 18],
    ["ORD-000915", "ICS Ground", "GR6C2BV3PTL8J8V9Z0W1", 6],
    ["ORD-000914", "ICS Standard", "ND6C2BV3PTL8VSJ4W3E2", 6],
    ["ORD-000913", "GLS Ground", "P62139873", 18],
    ["ORD-000912", "ICS Standard", "ND6C2BV3PTL9L5J0R1T0", 6],
    ["ORD-000911", "ICS Ground", "GR6C2BV3PTL9YXV9T5W3", 12],
    ["ORD-000910", "GLS Ground", "P62139991", 18],
    ["ORD-000909", "ICS Ground", "GR6C2BV3PTLANFT2X0Z8", 6],
    ["ORD-000908", "Canpar Ground", "D420352470002702366001", 18],
    ["ORD-000907", "GLS Ground", "P62140061", 6],
    ["ORD-000906", "ICS Ground", "GR6C2BV3PTLBRDT6W3V5", 6],
    ["ORD-000905", "ICS Standard", "ND6C2BV3PTLC3BJ6W6H5", 6],
    ["ORD-000904", "GLS Ground", "P62140083", 6],
    ["ORD-000903", "ICS Standard", "ND6C2BV3PTLCTBH4V1X4", 6],
    ["ORD-000901", "ICS Ground", "GR6C2BV3PTLD5KV9W2L9", 6],
    ["ORD-000900", "ICS Ground", "GR6C2BV3PTLDJ2V2A3E3", 6],
    ["ORD-000899", "GLS Ground", "P62140186", 12],
    ["ORD-000897", "ICS Standard", "ND6C2BV3PTLE7WH7X3N5", 6],
    ["ORD-000896", "ICS Ground", "GR6C2BV3PTLELZV9X1X6", 12],
    ["ORD-000895", "ICS Standard", "ND6C2BV3PTLEYWN9Y1Y6", 6],
    ["ORD-000893", "GLS Ground", "P62140212", 6],
    ["ORD-000891", "UPS Standard", "1ZV56D262033854273", 6],
    ["ORD-000890", "ICS Ground", "GR6C2BV3PTLG0PV1N3L9", 6],
    ["ORD-000889", "ICS Ground", "GR6C2BV3PTLGDDT2E1S2", 6],
    ["ORD-000888", "ICS Standard", "ND6C2BV3PTLGRQL3Y3E8", 6],
    ["ORD-000887", "ICS Ground", "GR6C2BV3PTLH40V1L2T2", 12],
    ["ORD-000885", "GLS Ground", "P62140352", 6],
    ["ORD-000884", "ICS Ground", "GR6C2BV3PTLHV8T4C0W8", 6],
    ["ORD-000883", "ICS Standard", "ND6C2BV3PTLJ6VL1C6S6", 6],
    ["ORD-000882", "ICS Standard", "ND6C2BV3PTLJKHN7M0A6", 12],
    ["ORD-000881", "GLS Ground", "P62140433", 12],
    ["ORD-000879", "ICS Standard", "ND6C2BV3PTLK8UN0A1N7", 6],
    ["ORD-000876", "ICS Standard", "ND6C2BV3PTLKLGM4R1N5", 6]
].map(([orderCode, carrier, tracking, quantity]) => ({ orderCode, carrier, tracking, quantity }));

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function upper(value) {
    return clean(value).toUpperCase();
}

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnly(value) {
    if (!value) return "";
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    return clean(value).slice(0, 10);
}

function group(rows, key) {
    const output = new Map();
    for (const row of rows) {
        const value = clean(row[key]);
        if (!output.has(value)) output.set(value, []);
        output.get(value).push(row);
    }
    return output;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const codes = ROWS.map((row) => row.orderCode);
        const trackingNumbers = ROWS.map((row) => row.tracking);
        const orders = (await client.query(
            `select o.id,o.order_code,o.account_name,o.status,o.shipment_method,
                    o.shipped_carrier_name,o.shipped_tracking_reference,o.confirmed_ship_date,
                    o.shipment_email_status,fl.code as warehouse_code
             from portal_orders o
             left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=any($1::text[]) order by o.order_code`,
            [codes]
        )).rows;
        const orderIds = orders.map((row) => row.id);
        const lines = (await client.query(
            `select order_id,sum(requested_quantity)::integer as ordered_quantity
             from portal_order_lines where order_id=any($1::bigint[]) group by order_id`,
            [orderIds]
        )).rows;
        const shipments = (await client.query(
            `select ws.id,ws.order_id,ws.status,ws.shipment_method,ws.carrier_name,
                    ws.tracking_reference,ws.shipped_at,fl.code as warehouse_code
             from warehouse_shipments ws
             left join fulfillment_locations fl on fl.id=ws.fulfillment_location_id
             where ws.order_id=any($1::bigint[]) order by ws.order_id,ws.id`,
            [orderIds]
        )).rows;
        const shipmentIds = shipments.map((row) => row.id);
        const shipmentLines = (await client.query(
            `select ws.order_id,sum(sl.ordered_quantity)::integer as ordered_quantity,
                    sum(sl.shipped_quantity)::integer as shipped_quantity
             from warehouse_shipment_lines sl
             join warehouse_shipments ws on ws.id=sl.shipment_id
             where sl.shipment_id=any($1::bigint[]) group by ws.order_id`,
            [shipmentIds]
        )).rows;
        const ledger = (await client.query(
            `select source_id,count(*)::integer as entry_count,sum(quantity_delta)::integer as quantity_delta
             from inventory_transactions
             where source_type='PORTAL_ORDER' and transaction_type='SHIPPING'
               and source_id=any($1::text[])
             group by source_id`,
            [orderIds.map(String)]
        )).rows;
        const billing = (await client.query(
            `select coalesce(nullif(source_ref,''),source_reference) as order_code,
                    count(*)::integer as event_count,
                    count(distinct event_key)::integer as distinct_event_keys
             from billing_events
             where account_name=$1 and coalesce(nullif(source_ref,''),source_reference)=any($2::text[])
               and upper(status) <> 'VOID'
             group by coalesce(nullif(source_ref,''),source_reference)`,
            [ACCOUNT, codes]
        )).rows;
        const enabledRates = (await client.query(
            `select fee_code,rate from owner_billing_rates
             where account_name=$1 and is_enabled=true and fee_code=any($2::text[])`,
            [ACCOUNT, OUTBOUND_FEE_CODES]
        )).rows;
        const exports = (await client.query(
            `select entity_ref,count(*)::integer as export_count
             from store_sync_exports
             where entity_type=$1 and entity_ref=any($2::text[])
             group by entity_ref`,
            [SHOPIFY_EXPORT_TYPE, orderIds.map(String)]
        )).rows;
        const skips = (await client.query(
            `select title,details from activity_log
             where title=any($1::text[])`,
            [codes.map((code) => `Shopify fulfillment skipped for portal order ${code}`)]
        )).rows;
        const trackers = (await client.query(
            `select order_id,carrier_name,tracking_number,tracking_url,is_active
             from shipment_trackers where order_id=any($1::bigint[])`,
            [orderIds]
        )).rows;
        const duplicates = (await client.query(
            `select upper(trim(shipped_tracking_reference)) as tracking,count(*)::integer as order_count,
                    array_agg(order_code order by order_code) as order_codes
             from portal_orders
             where upper(trim(shipped_tracking_reference))=any($1::text[])
             group by upper(trim(shipped_tracking_reference)) having count(*) > 1`,
            [trackingNumbers.map(upper)]
        )).rows;

        const ordersByCode = group(orders, "order_code");
        const linesByOrder = group(lines, "order_id");
        const shipmentsByOrder = group(shipments, "order_id");
        const shipmentLinesByOrder = group(shipmentLines, "order_id");
        const ledgerByOrder = group(ledger, "source_id");
        const billingByCode = group(billing, "order_code");
        const exportsByOrder = group(exports, "entity_ref");
        const trackersByOrder = group(trackers, "order_id");

        const audit = ROWS.map((expected) => {
            const issues = [];
            const matches = ordersByCode.get(expected.orderCode) || [];
            if (matches.length !== 1) return { orderCode: expected.orderCode, issues: [`order match count ${matches.length}`] };
            const order = matches[0];
            const orderLines = linesByOrder.get(String(order.id)) || [];
            const orderShipments = shipmentsByOrder.get(String(order.id)) || [];
            const warehouseLines = shipmentLinesByOrder.get(String(order.id)) || [];
            const shippingLedger = ledgerByOrder.get(String(order.id)) || [];
            const orderBilling = billingByCode.get(expected.orderCode) || [];
            const orderExports = exportsByOrder.get(String(order.id)) || [];
            const orderTrackers = trackersByOrder.get(String(order.id)) || [];
            const safeSkip = skips.some((entry) => entry.title.endsWith(expected.orderCode) && /already fulfilled|no open fulfillment/i.test(clean(entry.details)));
            const orderedQuantity = orderLines.reduce((sum, row) => sum + number(row.ordered_quantity), 0);
            const warehouseOrdered = warehouseLines.reduce((sum, row) => sum + number(row.ordered_quantity), 0);
            const warehouseShipped = warehouseLines.reduce((sum, row) => sum + number(row.shipped_quantity), 0);
            const shippingDelta = shippingLedger.reduce((sum, row) => sum + number(row.quantity_delta), 0);
            const billingCount = orderBilling.reduce((sum, row) => sum + number(row.event_count), 0);
            const distinctBillingKeys = orderBilling.reduce((sum, row) => sum + number(row.distinct_event_keys), 0);

            if (upper(order.account_name) !== ACCOUNT) issues.push(`owner ${order.account_name}`);
            if (upper(order.warehouse_code) !== WAREHOUSE) issues.push(`warehouse ${order.warehouse_code || "blank"}`);
            if (upper(order.status) !== "SHIPPED") issues.push(`status ${order.status}`);
            if (upper(order.shipment_method) !== "PARCEL") issues.push(`method ${order.shipment_method}`);
            if (clean(order.shipped_carrier_name) !== expected.carrier) issues.push(`carrier ${order.shipped_carrier_name || "blank"}`);
            if (clean(order.shipped_tracking_reference) !== expected.tracking) issues.push(`tracking ${order.shipped_tracking_reference || "blank"}`);
            if (dateOnly(order.confirmed_ship_date) !== SHIP_DATE) issues.push(`ship date ${dateOnly(order.confirmed_ship_date) || "blank"}`);
            if (orderedQuantity !== expected.quantity) issues.push(`ordered quantity ${orderedQuantity}, expected ${expected.quantity}`);
            if (orderShipments.length !== 1) issues.push(`shipment count ${orderShipments.length}`);
            for (const shipment of orderShipments) {
                if (upper(shipment.status) !== "SHIPPED") issues.push(`shipment status ${shipment.status}`);
                if (upper(shipment.shipment_method) !== "PARCEL") issues.push(`shipment method ${shipment.shipment_method}`);
                if (clean(shipment.carrier_name) !== expected.carrier) issues.push(`shipment carrier ${shipment.carrier_name || "blank"}`);
                if (clean(shipment.tracking_reference) !== expected.tracking) issues.push(`shipment tracking ${shipment.tracking_reference || "blank"}`);
                if (upper(shipment.warehouse_code) !== WAREHOUSE) issues.push(`shipment warehouse ${shipment.warehouse_code || "blank"}`);
            }
            if (warehouseOrdered !== expected.quantity) issues.push(`shipment ordered ${warehouseOrdered}, expected ${expected.quantity}`);
            if (warehouseShipped !== expected.quantity) issues.push(`shipment shipped ${warehouseShipped}, expected ${expected.quantity}`);
            if (!shippingLedger.length || shippingDelta !== -expected.quantity) issues.push(`shipping ledger delta ${shippingDelta}, expected ${-expected.quantity}`);
            if (enabledRates.length && !billingCount) issues.push("billing evidence missing");
            if (billingCount !== distinctBillingKeys) issues.push(`duplicate billing keys ${billingCount - distinctBillingKeys}`);
            if (!orderExports.length && !safeSkip) issues.push("Shopify confirmation evidence missing");
            if (!["SENT", "SCHEDULED", "SENDING"].includes(upper(order.shipment_email_status))) issues.push(`shipment email ${order.shipment_email_status || "blank"}`);
            if (orderTrackers.length !== 1) issues.push(`tracker count ${orderTrackers.length}`);
            for (const tracker of orderTrackers) {
                if (clean(tracker.carrier_name) !== expected.carrier) issues.push(`tracker carrier ${tracker.carrier_name || "blank"}`);
                if (clean(tracker.tracking_number) !== expected.tracking) issues.push(`tracker number ${tracker.tracking_number || "blank"}`);
                if (!clean(tracker.tracking_url)) issues.push("tracker URL missing");
                if (tracker.is_active !== true) issues.push("tracker inactive");
            }
            return {
                orderCode: expected.orderCode,
                quantity: expected.quantity,
                carrier: order.shipped_carrier_name,
                tracking: order.shipped_tracking_reference,
                shopifyEvidence: orderExports.length ? "EXPORTED" : (safeSkip ? "ALREADY_FULFILLED" : "MISSING"),
                billingEventCount: billingCount,
                shipmentEmailStatus: order.shipment_email_status,
                issues: [...new Set(issues)]
            };
        });
        const mismatches = audit.filter((row) => row.issues.length);
        const shopifyBreakdown = audit.reduce((result, row) => {
            result[row.shopifyEvidence || "UNKNOWN"] = (result[row.shopifyEvidence || "UNKNOWN"] || 0) + 1;
            return result;
        }, {});
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            reconciledAt: new Date().toISOString(),
            requested: ROWS.length,
            totalQuantity: ROWS.reduce((sum, row) => sum + row.quantity, 0),
            shippedCount: audit.filter((row) => !row.issues.some((issue) => issue.startsWith("status "))).length,
            shopifyBreakdown,
            enabledOutboundFeeRates: enabledRates,
            duplicateTrackingCount: duplicates.length,
            duplicateTracking: duplicates,
            mismatchCount: mismatches.length,
            mismatches,
            verifiedOrderCodes: audit.filter((row) => !row.issues.length).map((row) => row.orderCode)
        }, null, 2));
        await client.query("rollback");
        if (mismatches.length || duplicates.length) process.exitCode = 2;
    } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
