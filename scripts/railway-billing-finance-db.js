const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const REQUIRED_TABLES = [
    "customer_billing_profiles",
    "rate_cards",
    "billing_events",
    "invoices",
    "payments",
    "payment_allocations",
    "journal_entries",
    "journal_entry_lines",
    "billing_finance_document_sequences"
];

function makeClient() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
    if (!connectionString) {
        throw new Error("DATABASE_URL is not available in the Railway environment.");
    }
    const parsed = new URL(connectionString);
    return new Client({
        connectionString,
        ssl: parsed.hostname.includes("railway.internal") ? false : { rejectUnauthorized: false }
    });
}

async function probe(client) {
    const tableResult = await client.query(
        "select table_name from information_schema.tables where table_schema = $1 and table_name = any($2::text[]) order by table_name",
        ["public", REQUIRED_TABLES]
    );
    const present = new Set(tableResult.rows.map((row) => row.table_name));
    for (const tableName of REQUIRED_TABLES) {
        console.log(`${tableName}: ${present.has(tableName) ? "present" : "missing"}`);
    }

    const columnResult = await client.query(
        `
            select table_name, column_name
            from information_schema.columns
            where table_schema = 'public'
              and (
                (table_name = 'invoices' and column_name = any($1::text[]))
                or (table_name = 'journal_entries' and column_name = any($2::text[]))
              )
            order by table_name, column_name
        `,
        [
            ["posting_status", "posted_at", "posted_journal_entry_id", "locked_at", "locked_by"],
            ["is_posted", "posted_at", "locked_at", "reversed_entry_id", "reversal_entry_id", "is_reversal"]
        ]
    );
    console.log("control_columns:");
    for (const row of columnResult.rows) {
        console.log(`- ${row.table_name}.${row.column_name}`);
    }
}

async function migrate(client) {
    await client.query("begin");
    try {
        for (const fileName of [
            "20260512_billing_finance_base.sql",
            "20260512_billing_finance_accounting_controls.sql"
        ]) {
            const migrationPath = path.resolve(__dirname, "..", "migrations", fileName);
            const sql = fs.readFileSync(migrationPath, "utf8");
            await client.query(sql);
            console.log(`migration: ${fileName} applied`);
        }
        await client.query("commit");
    } catch (error) {
        await client.query("rollback");
        throw error;
    }
}

async function main() {
    const command = process.argv[2] || "probe";
    const client = makeClient();
    await client.connect();
    try {
        const version = await client.query("select current_database() as db, current_user as user, version() as version");
        console.log(`database: ${version.rows[0].db}`);
        console.log(`user: ${version.rows[0].user}`);
        console.log(`postgres: ${String(version.rows[0].version).split(",")[0]}`);
        if (command === "migrate") {
            await migrate(client);
        }
        await probe(client);
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
