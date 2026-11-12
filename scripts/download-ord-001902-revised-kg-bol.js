"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const FILE = "WMS365_BOL_ORD-001902_2026-11-05_1130AM_BISON_REVISED_KG.pdf";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const result = await pool.query(`
            select d.file_data
            from portal_order_documents d
            join portal_orders o on o.id = d.order_id
            where o.order_code = 'ORD-001902'
              and o.account_name = 'ALCONA TRADING LTD'
              and d.file_name = $1
              and d.document_category = 'SHIPMENT_BOL'
        `, [FILE]);
        if (result.rowCount !== 1) throw new Error("Exact revised KG BOL was not found.");
        const output = path.resolve("output", "pdf", FILE);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, result.rows[0].file_data);
        console.log(JSON.stringify({ output, bytes: result.rows[0].file_data.length }));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
