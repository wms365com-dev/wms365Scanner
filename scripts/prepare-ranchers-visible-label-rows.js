"use strict";

const { Client } = require("pg");
const { main: readSnapshot } = require("./read-ranchers-clickship-queue");
const { build, HEADERS } = require("./prepare-ranchers-clickship-rows");

const DEFAULT_TARGETS = [
    "ORD-001673", "ORD-001674", "ORD-001679", "ORD-001682", "ORD-001683",
    "ORD-001691", "ORD-001692", "ORD-001693", "ORD-001694", "ORD-001695"
];
const requested = process.argv.find((arg) => arg.startsWith("--orders="));
const TARGETS = new Set((requested ? requested.slice("--orders=".length).split(",") : DEFAULT_TARGETS)
    .map((value) => String(value || "").trim()).filter((value) => /^ORD-\d{6}$/.test(value)));

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection unavailable");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        const snapshot = await readSnapshot({ client: db, print: false, statuses: ["RELEASED", "STAGED"] });
        const prepared = build(snapshot);
        const rows = prepared.rows.filter((row) => TARGETS.has(row[1]));
        if (rows.length !== TARGETS.size) {
            const found = new Set(rows.map((row) => row[1]));
            throw new Error(`Missing eligible rows: ${[...TARGETS].filter((code) => !found.has(code)).join(", ")}`);
        }
        if (rows.some((row) => row.length !== HEADERS.length)) throw new Error("Label row width mismatch");
        console.log(JSON.stringify({ headers: HEADERS, rows }));
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
