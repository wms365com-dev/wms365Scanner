const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Client } = require("pg");
const { chromium } = require("playwright");
const { getPortalOrderById } = require("../server");

const ACCOUNT_NAME = "WELLFORIA HEALTH INC";
const WAREHOUSE_CODE = "GW3PL-MISS";
const ORDER_CODES = Array.from({ length: 28 }, (_, index) => `S-ORD${101184 + index}`);
const OUTPUT_PATH = path.resolve("output/pdf/wellforia-28-pick-tickets.pdf");

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Unable to locate ${name} in index.html.`);
    const next = source.indexOf("\n        function ", start + marker.length);
    if (next < 0) throw new Error(`Unable to find the end of ${name} in index.html.`);
    return source.slice(start, next).trim();
}

function buildRenderer() {
    const source = fs.readFileSync(path.resolve("index.html"), "utf8");
    const functionNames = [
        "norm",
        "num",
        "normalizeTrackingLevel",
        "formatLabelDate",
        "attr",
        "esc",
        "code39PatternFor",
        "buildCode39Svg",
        "formatTrackedQuantity",
        "formatPickLocationHtml",
        "formatPortalOrderShipTo",
        "isGreyWolfEdwardsShipFrom",
        "getPortalOrderShipFromLocation",
        "getPortalOrderShipFromName",
        "formatPortalOrderShipFrom",
        "buildPickTicketHtml",
        "buildBatchPickTicketHtml"
    ];
    const context = vm.createContext({
        getPrimaryFulfillmentAssignment: () => null,
        getFulfillmentLocationByCode: () => null
    });
    vm.runInContext(functionNames.map((name) => extractFunction(source, name)).join("\n"), context);
    return context.buildBatchPickTicketHtml;
}

async function loadOrders(client) {
    const result = await client.query(
        `select id, order_code, account_name, status
           from portal_orders
          where order_code = any($1::text[])
          order by order_code`,
        [ORDER_CODES]
    );
    if (result.rowCount !== ORDER_CODES.length) {
        throw new Error(`Expected 28 Wellforia orders, found ${result.rowCount}.`);
    }
    const actualCodes = result.rows.map((row) => row.order_code);
    if (JSON.stringify(actualCodes) !== JSON.stringify(ORDER_CODES)) {
        throw new Error(`Order-set mismatch: ${actualCodes.join(", ")}`);
    }
    for (const row of result.rows) {
        if (row.account_name !== ACCOUNT_NAME) {
            throw new Error(`${row.order_code} belongs to ${row.account_name}, not ${ACCOUNT_NAME}.`);
        }
        if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(row.status)) {
            throw new Error(`${row.order_code} is ${row.status} and is not printable.`);
        }
    }
    const orders = await Promise.all(result.rows.map((row) => getPortalOrderById(client, row.id, ACCOUNT_NAME)));
    for (const order of orders) {
        const locationCodes = (order.fulfillmentGroups || [])
            .map((group) => String(group?.location?.code || group?.location?.locationCode || "").trim().toUpperCase())
            .filter(Boolean);
        if (!locationCodes.length || locationCodes.some((code) => code !== WAREHOUSE_CODE)) {
            throw new Error(`${order.orderCode} is not fully assigned to ${WAREHOUSE_CODE}.`);
        }
    }
    return orders;
}

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("Production WMS365 identity mismatch.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let browser;
    try {
        const orders = await loadOrders(client);
        const renderBatch = buildRenderer();
        const html = renderBatch(orders);
        fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
        await page.setContent(html, { waitUntil: "load" });
        await page.pdf({
            path: OUTPUT_PATH,
            format: "Letter",
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: "0", right: "0", bottom: "0", left: "0" }
        });
        console.log(JSON.stringify({
            outputPath: OUTPUT_PATH,
            orderCount: orders.length,
            firstOrder: orders[0].orderCode,
            lastOrder: orders[orders.length - 1].orderCode
        }));
    } finally {
        if (browser) await browser.close();
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
    });
}

module.exports = { main };
