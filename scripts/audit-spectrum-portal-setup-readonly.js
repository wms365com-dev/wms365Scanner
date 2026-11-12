const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const companies = await pool.query(
            `select id, name, legal_name, is_active, wms_access_mode, wms_subscription_status,
                    feature_flags
             from owner_accounts
             where name ilike '%spectrum%' or legal_name ilike '%spectrum%'
             order by name`
        );
        const accountNames = companies.rows.map((row) => row.name);
        const users = accountNames.length
            ? await pool.query(
                `select id, account_name, email, is_active, portal_permissions, last_login_at
                 from portal_vendor_access
                 where account_name=any($1::text[])
                 order by account_name, email`,
                [accountNames]
            )
            : { rows: [] };
        const warehouses = accountNames.length
            ? await pool.query(
                `select cfl.account_name, fl.id, fl.code, fl.name, fl.address1, fl.city, fl.state,
                        fl.postal_code, fl.is_active, cfl.is_primary, cfl.allow_inbound,
                        cfl.allow_outbound, cfl.allow_storage, cfl.allow_returns
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=any($1::text[])
                 order by cfl.account_name, cfl.is_primary desc, fl.name`,
                [accountNames]
            )
            : { rows: [] };
        console.log(JSON.stringify({ companies: companies.rows, users: users.rows, warehouses: warehouses.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
