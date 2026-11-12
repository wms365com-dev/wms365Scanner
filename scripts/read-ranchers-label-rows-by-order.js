"use strict";

const { Client } = require("pg");
const { main: readSnapshot } = require("./read-ranchers-clickship-queue");
const { build } = require("./prepare-ranchers-clickship-rows");

async function main(orderCodes = process.argv.slice(2)) {
    const expected = new Set(orderCodes);
    if (!expected.size || [...expected].some((code) => !/^ORD-\d{6}$/.test(code))) {
        throw new Error("Provide one or more exact WMS order codes.");
    }
    const client = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        connectionTimeoutMillis: 15000
    });
    await client.connect();
    try {
        const snapshot = await readSnapshot({ client, print: false, statuses: ["RELEASED", "STAGED"] });
        const result = build(snapshot);
        const rows = result.rows.filter((row) => expected.has(row[1]));
        if (rows.length !== expected.size || new Set(rows.map((row) => row[1])).size !== expected.size) {
            throw new Error("Not every requested order produced exactly one eligible label row.");
        }
        console.log(JSON.stringify({ headers: result.headers, rows }));
    } finally {
        await client.end();
    }
}

module.exports = { main };
if (require.main === module) main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
