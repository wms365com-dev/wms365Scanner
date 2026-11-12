const fs = require("node:fs");
const vm = require("node:vm");
const { Client } = require("pg");
const { getPortalOrderById, buildPortalOrderPickTicketLines } = require("../server");

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
            "select id, account_name, status from portal_orders where order_code=$1", ["ORD-001075"]
        );
        if (result.rowCount !== 1 || result.rows[0].account_name !== "ZETA GROUP (CANADA) LTD.") {
            throw new Error("ORD-001075 customer identity mismatch.");
        }
        const order = await getPortalOrderById(client, result.rows[0].id, result.rows[0].account_name);
        const htmlSource = fs.readFileSync("index.html", "utf8");
        const functionSource = "function buildPickTicketHtml(" + htmlSource
            .split("function buildPickTicketHtml(")[1].split("function buildPackingSlipHtml(")[0];
        const render = vm.runInNewContext(`(${functionSource})`, {
            buildCode39Svg: () => "", formatPortalOrderShipFrom: () => "",
            formatPortalOrderShipTo: () => "", formatTrackedQuantity: (quantity) => String(quantity),
            formatPickLocationHtml: () => "", esc: (value) => String(value)
        });
        const html = render(order);
        const pdfLines = buildPortalOrderPickTicketLines(order);
        const codes = ["19421905946343", "19421905946350"];
        if (!html.includes("<th>UPC</th>") || !codes.every((code) => html.includes(`<td>${code}</td>`)
            && pdfLines.includes(`    UPC: ${code}`))
            || codes.some((code) => html.includes(`${code}.0`) || pdfLines.some((line) => line.includes(`${code}.0`)))) {
            throw new Error("The deployed ORD-001075 pick ticket is missing a clean UPC value.");
        }
        console.log(JSON.stringify({ orderCode: order.orderCode, status: order.status,
            browserPickTicket: "verified", pdfPickTicket: "verified", upcs: codes }));
    } finally {
        await client.end();
    }
}

module.exports = { main };
