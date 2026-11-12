const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const WAREHOUSE = "GW3PL-MISS";
const SOURCE = path.resolve(__dirname, "..", "outputs", "ranchers-shipping-second-batch-20260910.json");
const SOURCE_SHA256 = "46fcc24d239b295992855e761fdbb2846e4346900dfc23f46d0a1a931f09fda4";
const SHOPIFY_EXPORT_TYPE = "SHOPIFY_FULFILLMENT";
const CORE_BILLING = [
    ["SHIPPING_ADMINISTRATION_FEE", "SHIP_ADMIN", () => 1],
    ["ORDER_PROCESSING_FIRST_ITEM", "B2C_FIRST", () => 1],
    ["ADDITIONAL_ITEM_PICK", "B2C_ADDITIONAL", (quantity) => Math.max(0, quantity - 1)]
];

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
    const sourceBytes = fs.readFileSync(SOURCE);
    const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    if (sourceHash !== SOURCE_SHA256) throw new Error(`Frozen source checksum mismatch: ${sourceHash}`);
    const sourceRows = JSON.parse(sourceBytes.toString("utf8")).rows || [];
    const approvedRows = sourceRows.filter((row) => clean(row.carrier) && clean(row.tracking));
    const excludedRows = sourceRows.filter((row) => !clean(row.carrier) || !clean(row.tracking));
    const codes = sourceRows.map((row) => clean(row.orderCode));

    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const orders = (await client.query(
            `select o.id, o.order_code, o.account_name, o.status, o.po_number,
                    o.shipment_method, o.shipped_carrier_name, o.shipped_tracking_reference,
                    o.confirmed_ship_date, o.shipped_at, o.shipment_email_status,
                    o.fulfillment_location_id, fl.code as warehouse_code
             from portal_orders o
             left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=any($1::text[])
             order by o.order_code`,
            [codes]
        )).rows;
        const orderIds = orders.map((row) => row.id);
        const lines = (await client.query(
            `select l.order_id, l.id as order_line_id, l.sku, l.requested_quantity,
                    c.tracking_level, c.unit_uom
             from portal_order_lines l
             left join portal_orders o on o.id=l.order_id
             left join item_catalog c on c.account_name=o.account_name and c.sku=l.sku
             where l.order_id=any($1::bigint[])
             order by l.order_id, l.line_number, l.id`,
            [orderIds]
        )).rows;
        const shipments = (await client.query(
            `select ws.id, ws.order_id, ws.shipment_code, ws.account_name, ws.status,
                    ws.shipment_method, ws.carrier_name, ws.tracking_reference,
                    ws.shipped_at, fl.code as warehouse_code
             from warehouse_shipments ws
             left join fulfillment_locations fl on fl.id=ws.fulfillment_location_id
             where ws.order_id=any($1::bigint[])
             order by ws.order_id, ws.id`,
            [orderIds]
        )).rows;
        const shipmentIds = shipments.map((row) => row.id);
        const shipmentLines = (await client.query(
            `select ws.order_id, sl.shipment_id, sl.order_line_id, sl.sku,
                    sl.ordered_quantity, sl.shipped_quantity
             from warehouse_shipment_lines sl
             join warehouse_shipments ws on ws.id=sl.shipment_id
             where sl.shipment_id=any($1::bigint[])
             order by ws.order_id, sl.id`,
            [shipmentIds]
        )).rows;
        const ledger = (await client.query(
            `select source_id, transaction_type, source_type, account_name, warehouse_id,
                    fulfillment_location_id, location, sku, quantity_delta,
                    quantity_before, quantity_after, idempotency_key, server_timestamp
             from inventory_transactions
             where source_type='PORTAL_ORDER' and source_id=any($1::text[])
             order by source_id, id`,
            [orderIds.map(String)]
        )).rows;
        const billing = (await client.query(
            `select id, event_key, account_name, fee_code, quantity, rate, amount,
                    service_date, status, source_type, source_ref, source_reference
             from billing_events
             where account_name=$1
               and (source_ref=any($2::text[]) or source_reference=any($2::text[]))
             order by source_ref, source_reference, id`,
            [ACCOUNT, codes]
        )).rows;
        const rates = (await client.query(
            `select fee_code, rate, is_enabled
             from owner_billing_rates
             where account_name=$1 and fee_code=any($2::text[])`,
            [ACCOUNT, CORE_BILLING.map(([fee]) => fee)]
        )).rows;
        const imports = (await client.query(
            `select soi.portal_order_id, soi.external_order_id, si.id as integration_id,
                    si.account_name, si.provider, si.integration_name, si.store_identifier,
                    si.is_active, si.settings
             from store_order_imports soi
             join store_integrations si on si.id=soi.integration_id
             where soi.portal_order_id=any($1::bigint[])
             order by soi.portal_order_id`,
            [orderIds]
        )).rows;
        const exports = (await client.query(
            `select integration_id, entity_type, entity_ref, content_hash, remote_path, created_at
             from store_sync_exports
             where entity_type=$1 and entity_ref=any($2::text[])
             order by entity_ref, created_at`,
            [SHOPIFY_EXPORT_TYPE, orderIds.map(String)]
        )).rows;
        const skipped = (await client.query(
            `select title, details, created_at
             from activity_log
             where title=any($1::text[])
             order by created_at`,
            [codes.map((code) => `Shopify fulfillment skipped for portal order ${code}`)]
        )).rows;
        const statusCounts = (await client.query(
            `select status, count(*)::integer as count
             from portal_orders where account_name=$1 group by status order by status`,
            [ACCOUNT]
        )).rows;

        const ordersByCode = group(orders, "order_code");
        const linesByOrder = group(lines, "order_id");
        const shipmentsByOrder = group(shipments, "order_id");
        const shipmentLinesByOrder = group(shipmentLines, "order_id");
        const ledgerByOrder = group(ledger, "source_id");
        const billingByCode = new Map();
        for (const event of billing) {
            const code = clean(event.source_ref || event.source_reference);
            if (!billingByCode.has(code)) billingByCode.set(code, []);
            billingByCode.get(code).push(event);
        }
        const importsByOrder = group(imports, "portal_order_id");
        const exportsByOrder = group(exports, "entity_ref");
        const skippedByCode = new Map();
        for (const entry of skipped) {
            const code = codes.find((candidate) => entry.title.endsWith(candidate));
            if (!code) continue;
            if (!skippedByCode.has(code)) skippedByCode.set(code, []);
            skippedByCode.get(code).push(entry);
        }
        const enabledRates = new Map(rates.filter((row) => row.is_enabled === true).map((row) => [clean(row.fee_code), number(row.rate)]));

        const approvedAudit = approvedRows.map((sourceRow) => {
            const issues = [];
            const code = clean(sourceRow.orderCode);
            const matches = ordersByCode.get(code) || [];
            const order = matches.length === 1 ? matches[0] : null;
            if (matches.length !== 1) issues.push(`order match count ${matches.length}`);
            if (!order) return { orderCode: code, issues };
            const orderLines = linesByOrder.get(String(order.id)) || [];
            const orderShipments = shipmentsByOrder.get(String(order.id)) || [];
            const warehouseLines = shipmentLinesByOrder.get(String(order.id)) || [];
            const orderLedger = ledgerByOrder.get(String(order.id)) || [];
            const orderBilling = billingByCode.get(code) || [];
            const orderImports = importsByOrder.get(String(order.id)) || [];
            const orderExports = exportsByOrder.get(String(order.id)) || [];
            const safeSkips = (skippedByCode.get(code) || []).filter((entry) => /already fulfilled|no open fulfillment/i.test(clean(entry.details)));
            const expectedQuantity = number(sourceRow.itemQuantityEa);
            const orderedQuantity = orderLines.reduce((sum, row) => sum + number(row.requested_quantity), 0);
            const warehouseOrdered = warehouseLines.reduce((sum, row) => sum + number(row.ordered_quantity), 0);
            const warehouseShipped = warehouseLines.reduce((sum, row) => sum + number(row.shipped_quantity), 0);
            const shippingLedger = orderLedger.filter((row) => upper(row.transaction_type) === "SHIPPING");
            const pickingLedger = orderLedger.filter((row) => upper(row.transaction_type) === "PICKING");
            const shippingDelta = shippingLedger.reduce((sum, row) => sum + number(row.quantity_delta), 0);

            if (upper(order.account_name) !== ACCOUNT) issues.push(`owner ${order.account_name}`);
            if (upper(order.status) !== "SHIPPED") issues.push(`status ${order.status}`);
            if (upper(order.shipment_method) !== "PARCEL") issues.push(`order method ${order.shipment_method}`);
            if (clean(order.shipped_carrier_name) !== clean(sourceRow.carrier)) issues.push(`order carrier ${order.shipped_carrier_name || "blank"}`);
            if (clean(order.shipped_tracking_reference) !== clean(sourceRow.tracking)) issues.push(`order tracking ${order.shipped_tracking_reference || "blank"}`);
            if (upper(order.warehouse_code) !== WAREHOUSE) issues.push(`order warehouse ${order.warehouse_code || "blank"}`);
            if (orderedQuantity !== expectedQuantity) issues.push(`order quantity ${orderedQuantity}, expected ${expectedQuantity}`);
            if (orderLines.some((line) => upper(line.tracking_level) !== "UNIT" || upper(line.unit_uom) !== "EA")) issues.push("order line UOM is not UNIT/EA");
            if (orderShipments.length !== 1) issues.push(`warehouse shipment count ${orderShipments.length}`);
            for (const shipment of orderShipments) {
                if (upper(shipment.account_name) !== ACCOUNT) issues.push(`shipment owner ${shipment.account_name}`);
                if (upper(shipment.status) !== "SHIPPED") issues.push(`shipment status ${shipment.status}`);
                if (upper(shipment.shipment_method) !== "PARCEL") issues.push(`shipment method ${shipment.shipment_method}`);
                if (clean(shipment.carrier_name) !== clean(sourceRow.carrier)) issues.push(`shipment carrier ${shipment.carrier_name || "blank"}`);
                if (clean(shipment.tracking_reference) !== clean(sourceRow.tracking)) issues.push(`shipment tracking ${shipment.tracking_reference || "blank"}`);
                if (upper(shipment.warehouse_code) !== WAREHOUSE) issues.push(`shipment warehouse ${shipment.warehouse_code || "blank"}`);
            }
            if (warehouseOrdered !== expectedQuantity) issues.push(`warehouse ordered quantity ${warehouseOrdered}, expected ${expectedQuantity}`);
            if (warehouseShipped !== expectedQuantity) issues.push(`warehouse shipped quantity ${warehouseShipped}, expected ${expectedQuantity}`);
            if (!shippingLedger.length) issues.push("shipping ledger entry missing");
            if (shippingDelta !== -expectedQuantity) issues.push(`shipping ledger delta ${shippingDelta}, expected ${-expectedQuantity}`);
            if (shippingLedger.some((row) => upper(row.account_name) !== ACCOUNT || upper(row.warehouse_id) !== WAREHOUSE)) issues.push("shipping ledger ownership/warehouse mismatch");
            if (!pickingLedger.length || pickingLedger.some((row) => number(row.quantity_delta) !== 0)) issues.push("picking ledger missing or non-zero");

            for (const [feeCode, suffix, quantityFn] of CORE_BILLING) {
                if (!enabledRates.has(feeCode)) continue;
                const expectedBillingQuantity = quantityFn(expectedQuantity);
                if (expectedBillingQuantity <= 0) continue;
                const expectedKey = `ORDER:${order.id}:${suffix}`;
                const events = orderBilling.filter((event) => clean(event.event_key) === expectedKey);
                if (events.length !== 1) issues.push(`billing event ${expectedKey} count ${events.length}`);
                if (events.length === 1 && number(events[0].quantity) !== expectedBillingQuantity) {
                    issues.push(`billing ${feeCode} quantity ${events[0].quantity}, expected ${expectedBillingQuantity}`);
                }
            }
            const duplicateBillingKeys = [...new Set(orderBilling.map((event) => clean(event.event_key)).filter((key, index, keys) => key && keys.indexOf(key) !== index))];
            if (duplicateBillingKeys.length) issues.push(`duplicate billing keys ${duplicateBillingKeys.join(", ")}`);

            if (orderImports.length !== 1) issues.push(`Shopify import count ${orderImports.length}`);
            if (orderImports.some((entry) => upper(entry.account_name) !== ACCOUNT || upper(entry.provider) !== "SHOPIFY")) issues.push("Shopify import ownership/provider mismatch");
            if (!orderExports.length && !safeSkips.length) issues.push("Shopify fulfillment export/safe-skip evidence missing");
            if (orderExports.some((entry) => !clean(entry.remote_path))) issues.push("Shopify export remote path missing");
            if (!["SENT", "SCHEDULED", "SENDING"].includes(upper(order.shipment_email_status))) issues.push(`shipment email status ${order.shipment_email_status || "blank"}`);

            return {
                orderCode: code,
                expectedQuantity,
                status: order.status,
                carrier: order.shipped_carrier_name,
                tracking: order.shipped_tracking_reference,
                warehouseShipped,
                shippingLedgerDelta: shippingDelta,
                billingEventCount: orderBilling.length,
                shopifyEvidence: orderExports.length ? "EXPORTED" : (safeSkips.length ? "ALREADY_FULFILLED" : "MISSING"),
                shipmentEmailStatus: order.shipment_email_status,
                issues: [...new Set(issues)]
            };
        });

        const excludedAudit = excludedRows.map((sourceRow) => {
            const issues = [];
            const code = clean(sourceRow.orderCode);
            const matches = ordersByCode.get(code) || [];
            const order = matches.length === 1 ? matches[0] : null;
            if (matches.length !== 1) issues.push(`order match count ${matches.length}`);
            if (!order) return { orderCode: code, issues };
            const orderShipments = shipmentsByOrder.get(String(order.id)) || [];
            const orderLedger = ledgerByOrder.get(String(order.id)) || [];
            const orderBilling = billingByCode.get(code) || [];
            const orderExports = exportsByOrder.get(String(order.id)) || [];
            if (upper(order.status) === "SHIPPED") issues.push("excluded order was shipped");
            if (clean(order.shipped_carrier_name) || clean(order.shipped_tracking_reference)) issues.push("excluded order has carrier/tracking");
            if (orderShipments.some((shipment) => upper(shipment.status) === "SHIPPED")) issues.push("excluded warehouse shipment was shipped");
            if (orderLedger.some((entry) => upper(entry.transaction_type) === "SHIPPING")) issues.push("excluded order has shipping ledger entries");
            if (orderBilling.length) issues.push("excluded order has outbound billing events");
            if (orderExports.length) issues.push("excluded order has Shopify fulfillment export");
            return { orderCode: code, status: order.status, issues: [...new Set(issues)] };
        });

        const approvedMismatches = approvedAudit.filter((row) => row.issues.length);
        const excludedMismatches = excludedAudit.filter((row) => row.issues.length);
        const shopifyBreakdown = approvedAudit.reduce((summary, row) => {
            summary[row.shopifyEvidence] = (summary[row.shopifyEvidence] || 0) + 1;
            return summary;
        }, {});
        const emailBreakdown = approvedAudit.reduce((summary, row) => {
            summary[row.shipmentEmailStatus || "BLANK"] = (summary[row.shipmentEmailStatus || "BLANK"] || 0) + 1;
            return summary;
        }, {});
        const totalExpectedQuantity = approvedRows.reduce((sum, row) => sum + number(row.itemQuantityEa), 0);
        const totalShippingDelta = approvedAudit.reduce((sum, row) => sum + number(row.shippingLedgerDelta), 0);

        console.log(JSON.stringify({
            mode: "READ_ONLY",
            reconciledAt: new Date().toISOString(),
            sourceSha256: sourceHash,
            sourceRows: sourceRows.length,
            approvedCount: approvedRows.length,
            excludedCount: excludedRows.length,
            totalExpectedQuantityEa: totalExpectedQuantity,
            totalShippingLedgerDelta: totalShippingDelta,
            accountStatusCounts: statusCounts,
            shopifyBreakdown,
            shipmentEmailBreakdown: emailBreakdown,
            enabledCoreBillingRates: Object.fromEntries(enabledRates),
            approvedMismatchCount: approvedMismatches.length,
            approvedMismatches,
            excludedMismatchCount: excludedMismatches.length,
            excludedMismatches,
            excludedOrders: excludedAudit
        }, null, 2));
        await client.query("rollback");
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

