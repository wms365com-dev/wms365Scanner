const { Client } = require("pg");
const { getPortalOrderById } = require("../server");

const ACCOUNT_NAME = "WELLFORIA HEALTH INC";
const WAREHOUSE_CODE = "GW3PL-MISS";
const ORDER_CODES = [
    "S-ORD101224",
    "S-ORD101225",
    "S-ORD101226",
    "S-ORD101227",
    "S-ORD101228",
];
const EMAIL_BY_ORDER = new Map([
    ["S-ORD101224", "DPATEL6664@GMAIL.COM"],
    ["S-ORD101225", "VIOLO151177@GMAIL.COM"],
    ["S-ORD101226", "ANNA.OKASHIMO@GMAIL.COM"],
    ["S-ORD101227", "SHREYA.SNSSJ@GMAIL.COM"],
    ["S-ORD101228", "SHAGUFTAKAUSAR5@GMAIL.COM"],
]);

function clean(value) {
    return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const result = await client.query(
            `select id, order_code, account_name, status
               from portal_orders
              where account_name = $1 and order_code = any($2::text[])
              order by order_code`,
            [ACCOUNT_NAME, ORDER_CODES]
        );
        if (result.rowCount !== ORDER_CODES.length) {
            throw new Error(`Expected ${ORDER_CODES.length} orders, found ${result.rowCount}.`);
        }

        const rows = [];
        for (const record of result.rows) {
            if (record.account_name !== ACCOUNT_NAME || record.status !== "RELEASED") {
                throw new Error(`${record.order_code} identity or status mismatch.`);
            }
            const order = await getPortalOrderById(client, record.id, ACCOUNT_NAME);
            const warehouseCodes = (order.fulfillmentGroups || [])
                .map((group) => clean(group?.location?.code || group?.location?.locationCode).toUpperCase())
                .filter(Boolean);
            if (!warehouseCodes.length || warehouseCodes.some((code) => code !== WAREHOUSE_CODE)) {
                throw new Error(`${record.order_code} warehouse mismatch.`);
            }
            for (const line of order.lines || []) {
                rows.push({
                    wmsOrder: order.orderCode,
                    poNumber: order.poNumber,
                    shippingReference: order.shippingReference,
                    status: order.status,
                    requestedShipDate: order.requestedShipDate,
                    shipToName: order.shipToName || order.contactName,
                    phone: order.shipToPhone || order.contactPhone,
                    address1: order.shipToAddress1,
                    address2: order.shipToAddress2,
                    city: order.shipToCity,
                    state: order.shipToState,
                    postalCode: order.shipToPostalCode,
                    country: order.shipToCountry,
                    sku: line.sku,
                    description: line.description,
                    upc: String(line.upc || "").replace(/^(\d+)\.0+$/, "$1"),
                    quantity: Number(line.quantity),
                    uom: line.uomLabel || line.trackingLevel || "EA",
                    pickLocation: (line.pickLocations || [])
                        .map((entry) => `${clean(entry.location)} (${clean(entry.quantity)})`).join("; "),
                    email: EMAIL_BY_ORDER.get(order.orderCode) || "",
                    trackingNumber: "",
                });
            }
        }
        await client.query("rollback");
        console.log(JSON.stringify({ account: ACCOUNT_NAME, warehouse: WAREHOUSE_CODE, rows }));
    } finally {
        await client.query("rollback").catch(() => {});
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
