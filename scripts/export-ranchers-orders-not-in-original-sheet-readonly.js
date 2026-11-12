const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const SOURCE_PATH = path.resolve(
    __dirname,
    "..",
    "outputs",
    "ranchers-shipping-match-20260910.json"
);
const OUTPUT_DIR = path.resolve(
    __dirname,
    "..",
    "outputs",
    "ranchers-orders-not-in-original-sheet"
);
const OUTPUT_PATH = path.join(OUTPUT_DIR, "ranchers-orders-not-in-original-sheet.json");

function text(value) {
    return String(value == null ? "" : value).trim();
}

function hasValidPhone(value) {
    return text(value).replace(/\D/g, "").length >= 7;
}

async function main() {
    const source = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8"));
    const sourceCodes = [...new Set((source.rows || []).map((row) => text(row.orderCode)).filter(Boolean))];
    if (sourceCodes.length !== 121) {
        throw new Error(`Expected 121 unique source order codes; found ${sourceCodes.length}.`);
    }

    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");

    const client = new Client({ connectionString, ssl: false });
    await client.connect();

    try {
        await client.query("begin transaction read only");

        const orderResult = await client.query(
            `select
                o.id,
                o.order_code,
                o.po_number,
                o.status,
                o.requested_ship_date,
                o.ship_to_name,
                o.ship_to_phone,
                o.ship_to_address1,
                o.ship_to_address2,
                o.ship_to_city,
                o.ship_to_state,
                o.ship_to_postal_code,
                o.ship_to_country,
                o.contact_name,
                o.contact_phone,
                o.shipment_method,
                o.shipped_carrier_name,
                o.shipped_tracking_reference,
                o.created_at,
                o.released_at,
                o.picked_at,
                o.staged_at,
                o.shipped_at,
                fl.code as warehouse_code,
                fl.name as warehouse_name,
                soi.external_order_id,
                count(*) over()::integer as total_account_orders
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             left join store_order_imports soi on soi.portal_order_id = o.id
             where o.account_name = $1
               and not (o.order_code = any($2::text[]))
             order by o.order_code`,
            [ACCOUNT, sourceCodes]
        );

        const orderIds = orderResult.rows.map((row) => row.id);
        const lineResult = orderIds.length
            ? await client.query(
                `select
                    l.order_id,
                    l.line_number,
                    l.sku,
                    l.requested_quantity,
                    c.description,
                    c.tracking_level,
                    c.unit_uom,
                    c.units_per_case
                 from portal_order_lines l
                 left join portal_orders o on o.id = l.order_id
                 left join item_catalog c on c.account_name = o.account_name and c.sku = l.sku
                 where l.order_id = any($1::bigint[])
                 order by l.order_id, l.line_number, l.id`,
                [orderIds]
            )
            : { rows: [] };

        const allCountResult = await client.query(
            `select count(*)::integer as order_count
             from portal_orders
             where account_name = $1`,
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
            const baseChecks = [];
            if (!text(order.external_order_id)) baseChecks.push("Missing Shopify external order ID");
            if (!text(order.warehouse_code)) baseChecks.push("Missing warehouse");
            if (!text(order.ship_to_name)) baseChecks.push("Missing recipient");
            if (!text(order.ship_to_address1)) baseChecks.push("Missing address line 1");
            if (!text(order.ship_to_city)) baseChecks.push("Missing city");
            if (!text(order.ship_to_state)) baseChecks.push("Missing province/state");
            if (!text(order.ship_to_postal_code)) baseChecks.push("Missing postal code");
            if (!text(order.ship_to_country)) baseChecks.push("Missing country");
            if (!hasValidPhone(order.ship_to_phone) && !hasValidPhone(order.contact_phone)) {
                baseChecks.push("Missing or invalid phone number");
            }
            if (!lines.length) baseChecks.push("No order lines");

            if (!lines.length) {
                details.push({
                    ...order,
                    line_number: null,
                    item_sku: "",
                    item_description: "",
                    item_quantity_ea: null,
                    data_check: baseChecks.join("; ") || "OK"
                });
                continue;
            }

            for (const line of lines) {
                const checks = [...baseChecks];
                if (!text(line.sku)) checks.push("Missing item SKU");
                if (!text(line.description)) checks.push("Missing item description");
                if (Number(line.requested_quantity) <= 0) checks.push("Quantity is zero or negative");
                if (text(line.tracking_level).toUpperCase() !== "UNIT" || text(line.unit_uom).toUpperCase() !== "EA") {
                    checks.push("Item is not configured as EA");
                }
                details.push({
                    ...order,
                    line_number: line.line_number,
                    item_sku: line.sku,
                    item_description: line.description,
                    item_quantity_ea: Number(line.requested_quantity),
                    data_check: checks.join("; ") || "OK"
                });
            }
        }

        const uniqueOrderCodes = new Set(orderResult.rows.map((row) => text(row.order_code)));
        const duplicateOrderCodes = orderResult.rows.length - uniqueOrderCodes.size;
        const allOrderCount = Number(allCountResult.rows[0]?.order_count || 0);
        const expectedDifference = allOrderCount - sourceCodes.length;

        const result = {
            generatedAt: new Date().toISOString(),
            accountName: ACCOUNT,
            source: {
                path: SOURCE_PATH,
                spreadsheetId: source.source?.spreadsheetId || "",
                excludedUniqueOrderCodes: sourceCodes.length
            },
            audit: {
                allOrderCount,
                excludedOrderCount: sourceCodes.length,
                expectedDifference,
                exportedOrderCount: uniqueOrderCodes.size,
                exportedDetailRowCount: details.length,
                duplicateOrderCodeCount: duplicateOrderCodes,
                uniqueExportedOrderCodes: uniqueOrderCodes.size,
                ordersWithDataWarnings: new Set(
                    details.filter((row) => row.data_check !== "OK").map((row) => row.order_code)
                ).size,
                reconciliationPass: expectedDifference === uniqueOrderCodes.size && duplicateOrderCodes === 0
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
