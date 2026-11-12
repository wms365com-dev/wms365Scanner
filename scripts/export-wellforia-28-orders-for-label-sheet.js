const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { getPortalOrderById } = require("../server");

const ACCOUNT_NAME = "WELLFORIA HEALTH INC";
const WAREHOUSE_CODE = "GW3PL-MISS";
const ORDER_CODES = Array.from({ length: 28 }, (_, index) => `S-ORD${101184 + index}`);
const OUTPUT_PATH = path.resolve("output/wellforia-28-label-sheet.tsv");

function clean(value) {
    return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("Production WMS365 identity mismatch.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        const result = await client.query(
            `select id, order_code, account_name, status
               from portal_orders
              where order_code = any($1::text[])
              order by order_code`,
            [ORDER_CODES]
        );
        if (result.rowCount !== 28) throw new Error(`Expected 28 orders, found ${result.rowCount}.`);
        const rows = [];
        for (const record of result.rows) {
            if (record.account_name !== ACCOUNT_NAME) throw new Error(`${record.order_code} account mismatch.`);
            if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(record.status)) {
                throw new Error(`${record.order_code} is not ready for label preparation.`);
            }
            const order = await getPortalOrderById(client, record.id, ACCOUNT_NAME);
            const groups = order.fulfillmentGroups || [];
            const codes = groups.map((group) => clean(group?.location?.code || group?.location?.locationCode).toUpperCase()).filter(Boolean);
            if (!codes.length || codes.some((code) => code !== WAREHOUSE_CODE)) {
                throw new Error(`${order.orderCode} warehouse mismatch.`);
            }
            for (const line of order.lines || []) {
                rows.push([
                    order.orderCode,
                    order.poNumber,
                    order.shippingReference,
                    order.status,
                    order.requestedShipDate,
                    order.shipToName || order.contactName,
                    order.shipToPhone || order.contactPhone,
                    order.shipToAddress1,
                    order.shipToAddress2,
                    order.shipToCity,
                    order.shipToState,
                    order.shipToPostalCode,
                    order.shipToCountry,
                    line.sku,
                    line.description,
                    String(line.upc || "").replace(/^(\d+)\.0+$/, "$1"),
                    line.quantity,
                    line.uomLabel || line.trackingLevel || "EA",
                    (line.pickLocations || []).map((entry) => `${clean(entry.location)} (${clean(entry.quantity)})`).join("; ")
                ].map(clean));
            }
        }
        const headers = [
            "WMS Order", "PO Number", "Shipping Reference", "Status", "Requested Ship Date",
            "Ship To Name", "Phone", "Address 1", "Address 2", "City", "Province/State",
            "Postal Code", "Country", "SKU", "Description", "UPC", "Quantity", "UOM", "Pick Location"
        ];
        if (new Set(rows.map((row) => row[0])).size !== 28) throw new Error("The export does not contain 28 unique orders.");
        fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
        fs.writeFileSync(OUTPUT_PATH, [headers, ...rows].map((row) => row.join("\t")).join("\r\n"), "utf8");
        console.log(JSON.stringify({ outputPath: OUTPUT_PATH, orderCount: 28, rowCount: rows.length }));
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
    });
}
