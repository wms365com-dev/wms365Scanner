const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
        await client.query("begin read only");
        await client.query("set local statement_timeout = '15s'");
        const result = await client.query(
            `select id::text, name, account_code, is_active, note
             from owner_accounts
             where name ilike '%codex%' or name ilike '%test%'
             order by id`
        );
        console.log(JSON.stringify({ companies: result.rows }, null, 2));
    } finally {
        await client.query("rollback");
        await client.end();
    }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
