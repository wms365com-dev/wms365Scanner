const { Pool } = require("pg");

function readEnv(name) {
    return String(process.env[name] || "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

async function main() {
    const shop = String(process.argv[2] || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
        throw new Error("Usage: node scripts/pause-shopify-integration-until-mapped.js store.myshopify.com");
    }
    const databaseUrl = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    if (!databaseUrl) throw new Error("DATABASE_URL is unavailable.");
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? false : { rejectUnauthorized: false }
    });
    try {
        const result = await pool.query(
            `update store_integrations
             set sync_schedule = 'MANUAL', next_scheduled_sync_at = null, updated_at = now()
             where provider = 'SHOPIFY' and lower(store_identifier) = $1
             returning id, account_name, sync_schedule`,
            [shop]
        );
        if (result.rowCount !== 1) throw new Error(`Expected one Shopify integration for ${shop}, found ${result.rowCount}.`);
        console.log(JSON.stringify({ ok: true, ...result.rows[0] }));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
    process.exitCode = 1;
});
