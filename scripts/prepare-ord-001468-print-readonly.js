const crypto = require("crypto");
const { Client } = require("pg");
const {
    getPortalOrderById,
    buildPortalOrderPickTicketPdfAttachments
} = require("../server");

const ORDER_CODE = "ORD-001468";
const ACCOUNT = "PRETTY GUTSY INC.";
const DOCUMENTS = new Map([
    ["839", "Invoice-25381BAA-DRAFT.pdf"],
    ["840", "Shipping Labels (7).pdf"]
]);

function pdf(fileName, content) {
    if (!Buffer.isBuffer(content) || content.toString("ascii", 0, 4) !== "%PDF") {
        throw new Error("A print document is not a PDF");
    }
    return {
        fileName,
        size: content.length,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        base64: content.toString("base64")
    };
}

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await client.connect();
    try {
        await client.query("begin read only");
        const result = await client.query(
            `select id, order_code, account_name, status, fulfillment_location_id
             from portal_orders where order_code = $1`, [ORDER_CODE]
        );
        if (result.rowCount !== 1) throw new Error("Order identity is not unique");
        const order = result.rows[0];
        if (order.account_name !== ACCOUNT || order.status !== "RELEASED"
            || Number(order.fulfillment_location_id) !== 1) {
            throw new Error("Order ownership, stage or warehouse changed");
        }
        const fullOrder = await getPortalOrderById(client, order.id, ACCOUNT);
        const tickets = buildPortalOrderPickTicketPdfAttachments(fullOrder);
        if (tickets.length !== 1) throw new Error("Expected one Mississauga pick ticket");
        const documents = await client.query(
            `select id, file_name, file_type, file_data
             from portal_order_documents where order_id = $1 order by id`, [order.id]
        );
        if (documents.rowCount !== DOCUMENTS.size) throw new Error("Order attachments changed");
        const files = [pdf(tickets[0].filename, tickets[0].content)];
        for (const document of documents.rows) {
            if (DOCUMENTS.get(String(document.id)) !== document.file_name
                || document.file_type !== "application/pdf") {
                throw new Error("Order attachment identity or type changed");
            }
            files.push(pdf(document.file_name, document.file_data));
        }
        await client.query("rollback");
        console.log(JSON.stringify({ orderCode: ORDER_CODE, account: ACCOUNT,
            warehouse: "GW3PL-MISS", files }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
