const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const result = await pool.query(
            `select sku, upc, description, tracking_level, coalesce(unit_uom, '') as unit_uom,
                    coalesce(units_per_case, 0) as units_per_case, blocked
             from item_catalog
             where account_name = 'HEALTEA'
               and (
                    description ilike '%CAN%'
                    or description ilike '%PEPPERMINT%'
                    or description ilike '%GINGER%'
                    or description ilike '%NETTLE%'
                    or description ilike '%HIBISCUS%'
               )
             order by description, sku`
        );
        console.log(JSON.stringify(result.rows, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
