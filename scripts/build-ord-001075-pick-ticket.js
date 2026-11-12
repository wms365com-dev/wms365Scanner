const { Client } = require("pg");
const { getPortalOrderById, buildPortalOrderPickTicketPdfAttachment } = require("../server");

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
            "select id, account_name, status, fulfillment_location_id from portal_orders where order_code=$1",
            ["ORD-001075"]
        );
        const row = result.rows[0];
        if (result.rowCount !== 1 || row.account_name !== "ZETA GROUP (CANADA) LTD."
            || row.status !== "RELEASED" || Number(row.fulfillment_location_id) !== 1) {
            throw new Error("ORD-001075 identity, warehouse, or status changed.");
        }
        const order = await getPortalOrderById(client, row.id, row.account_name);
        const expected = new Map([
            ["S164", { quantity: 10, upc: "19421905946343" }],
            ["S165", { quantity: 54, upc: "19421905946350" }]
        ]);
        if (!order || order.orderCode !== "ORD-001075" || order.lines.length !== expected.size) {
            throw new Error("ORD-001075 detail changed.");
        }
        order.lines = order.lines.map((line) => {
            const raw = String(line.upc || "").trim();
            const upc = /^\d+\.0+$/.test(raw) ? raw.replace(/\.0+$/, "") : raw;
            const item = expected.get(line.sku);
            if (!item || line.quantity !== item.quantity || upc !== item.upc) {
                throw new Error(`Order line ${line.sku} no longer matches the checked pick-ticket details.`);
            }
            return { ...line, upc };
        });
        const attachment = buildPortalOrderPickTicketPdfAttachment(order);
        if (!Buffer.isBuffer(attachment.content) || !attachment.content.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
            throw new Error("Pick-ticket PDF was not generated.");
        }
        console.log("PICK_TICKET_BASE64:" + attachment.content.toString("base64"));
        console.log("PICK_TICKET_SUMMARY:" + JSON.stringify({
            orderCode: order.orderCode,
            lines: order.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, upc: line.upc })),
            bytes: attachment.content.length
        }));
    } finally {
        await client.end();
    }
}

module.exports = { main };
