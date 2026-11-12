const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const OUTPUT = path.resolve(__dirname, "..", "outputs", "spectrum-inb-000209", "GW-1311-26.pdf");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await db.connect();
    try {
        await db.query("begin read only");
        const result = await db.query(
            `select d.file_name,d.file_type,d.file_size,d.file_data
             from portal_inbound_documents d join portal_inbounds i on i.id=d.inbound_id
             where i.inbound_code='INB-000209' and i.account_name='SPECTRUM DYES & PIGMENTS INC.'
               and d.document_category='SHIPMENT_PACKING_SLIP'`
        );
        if (result.rowCount !== 1) throw new Error("Expected one Spectrum packing slip for INB-000209.");
        const row = result.rows[0];
        const buffer = Buffer.from(row.file_data);
        if (row.file_name !== "GW-1311-26.pdf" || row.file_type !== "application/pdf"
            || buffer.length !== Number(row.file_size) || buffer.length === 0) {
            throw new Error("Stored packing slip identity or size did not verify.");
        }
        await db.query("rollback");
        fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
        fs.writeFileSync(OUTPUT, buffer);
        console.log(JSON.stringify({ mode: "READ_ONLY_EXPORT", output: OUTPUT, bytes: buffer.length }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
