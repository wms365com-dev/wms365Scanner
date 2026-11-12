const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const OUTPUT_DIR = path.resolve(__dirname, "..", "outputs", "ranchers-current-released-orders");
const FULL_LABEL_QUEUE = process.argv.includes("--full-label-queue");
const INCLUDED_STATUSES = FULL_LABEL_QUEUE ? ["RELEASED", "STAGED"] : ["RELEASED"];
const OUTPUT_PATH = path.join(OUTPUT_DIR, FULL_LABEL_QUEUE
    ? "ranchers-full-label-queue.json"
    : "ranchers-current-released-orders.json");

function text(value) {
    return String(value == null ? "" : value).trim();
}

function hasValidPhone(value) {
    return text(value).replace(/\D/g, "").length >= 7;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");

    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");

        const orderResult = await client.query(
            `select
                o.id, o.order_code, o.po_number, o.status, o.requested_ship_date,
                o.ship_to_name, o.ship_to_phone, o.ship_to_address1, o.ship_to_address2,
                o.ship_to_city, o.ship_to_state, o.ship_to_postal_code, o.ship_to_country,
                o.contact_name, o.contact_phone, o.order_notes, o.shipment_method,
                o.shipped_carrier_name, o.shipped_tracking_reference, o.created_at,
                o.released_at, fl.code as warehouse_code, fl.name as warehouse_name,
                soi.external_order_id
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             left join store_order_imports soi on soi.portal_order_id = o.id
             where o.account_name = $1 and o.status = any($2::text[])
             order by coalesce(o.requested_ship_date, o.created_at::date), o.created_at, o.id`,
            [ACCOUNT, INCLUDED_STATUSES]
        );

        const orderIds = orderResult.rows.map((row) => row.id);
        const lineResult = orderIds.length
            ? await client.query(
                `select l.order_id, l.line_number, l.sku, l.requested_quantity,
                        c.description, c.tracking_level, c.unit_uom, c.units_per_case
                 from portal_order_lines l
                 left join portal_orders o on o.id = l.order_id
                 left join item_catalog c on c.account_name = o.account_name and c.sku = l.sku
                 where l.order_id = any($1::bigint[])
                 order by l.order_id, l.line_number, l.id`,
                [orderIds]
            )
            : { rows: [] };

        const countsResult = await client.query(
            `select status, count(*)::integer as count
             from portal_orders where account_name = $1
             group by status order by status`,
            [ACCOUNT]
        );
        await client.query("commit");

        const linesByOrder = new Map();
        for (const line of lineResult.rows) {
            const key = String(line.order_id);
            if (!linesByOrder.has(key)) linesByOrder.set(key, []);
            linesByOrder.get(key).push(line);
        }

        const details = [];
        for (const order of orderResult.rows) {
            const lines = linesByOrder.get(String(order.id)) || [];
            const checks = [];
            if (!text(order.external_order_id)) checks.push("Missing Shopify external order ID");
            if (!text(order.warehouse_code)) checks.push("Missing warehouse");
            if (!text(order.ship_to_name)) checks.push("Missing recipient");
            if (!text(order.ship_to_address1)) checks.push("Missing address line 1");
            if (!text(order.ship_to_city)) checks.push("Missing city");
            if (!text(order.ship_to_state)) checks.push("Missing province/state");
            if (!text(order.ship_to_postal_code)) checks.push("Missing postal code");
            if (!text(order.ship_to_country)) checks.push("Missing country");
            if (!hasValidPhone(order.ship_to_phone) && !hasValidPhone(order.contact_phone)) {
                checks.push("Missing or invalid phone number");
            }
            if (lines.length !== 1) checks.push(`Expected one order line; found ${lines.length}`);

            for (const line of lines) {
                const lineChecks = [...checks];
                if (!text(line.sku)) lineChecks.push("Missing item SKU");
                if (!text(line.description)) lineChecks.push("Missing item description");
                if (Number(line.requested_quantity) <= 0) lineChecks.push("Quantity is zero or negative");
                if (text(line.tracking_level).toUpperCase() !== "UNIT" || text(line.unit_uom).toUpperCase() !== "EA") {
                    lineChecks.push("Item is not configured as EA");
                }
                details.push({
                    ...order,
                    line_number: line.line_number,
                    item_sku: line.sku,
                    item_description: line.description,
                    item_quantity_ea: Number(line.requested_quantity),
                    data_check: lineChecks.join("; ") || "OK"
                });
            }
        }

        const statusCounts = Object.fromEntries(countsResult.rows.map((row) => [row.status, Number(row.count)]));
        const expectedExportedOrderCount = INCLUDED_STATUSES.reduce(
            (sum, status) => sum + (statusCounts[status] || 0),
            0
        );
        const uniqueOrderCodes = new Set(orderResult.rows.map((row) => text(row.order_code)));
        const duplicateOrderCodeCount = orderResult.rows.length - uniqueOrderCodes.size;
        const result = {
            generatedAt: new Date().toISOString(),
            accountName: ACCOUNT,
            source: {
                type: FULL_LABEL_QUEUE
                    ? "WMS365 live read-only released and staged shipping queue"
                    : "WMS365 live read-only released-order snapshot",
                includedStatuses: INCLUDED_STATUSES
            },
            audit: {
                allOrderCount: countsResult.rows.reduce((sum, row) => sum + Number(row.count), 0),
                processedOrderCount: statusCounts.SHIPPED || 0,
                currentReleasedOrderCount: statusCounts.RELEASED || 0,
                currentStagedOrderCount: statusCounts.STAGED || 0,
                excludedDraftOrderCount: statusCounts.DRAFT || 0,
                expectedExportedOrderCount,
                exportedOrderCount: uniqueOrderCodes.size,
                exportedDetailRowCount: details.length,
                duplicateOrderCodeCount,
                ordersWithDataWarnings: new Set(details.filter((row) => row.data_check !== "OK").map((row) => row.order_code)).size,
                reconciliationPass: uniqueOrderCodes.size === expectedExportedOrderCount && duplicateOrderCodeCount === 0
            },
            orders: orderResult.rows,
            details
        };

        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ outputPath: OUTPUT_PATH, ...result.audit }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
