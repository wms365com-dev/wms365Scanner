"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const result = await pool.query(`select d.file_name,d.file_data from portal_inbound_documents d
            join portal_inbounds i on i.id=d.inbound_id
            where i.inbound_code='INB-000210' and i.account_name='SPECTRUM DYES & PIGMENTS INC.'
              and d.document_category='SHIPMENT_PACKING_SLIP'`);
        if (result.rowCount !== 1) throw new Error("Exact packing slip not found.");
        const target = path.resolve("output", "pdf", "INB-000210_GW-1314-26.pdf");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, result.rows[0].file_data);
        console.log(JSON.stringify({ target, bytes: result.rows[0].file_data.length }));
    } finally { await pool.end(); }
}
main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
