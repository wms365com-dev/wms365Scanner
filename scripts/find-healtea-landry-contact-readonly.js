const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const portalUsers = await pool.query(
            `select account_name, email, is_active
             from portal_vendor_access
             where account_name='HEALTEA' or lower(email) like '%landry%'
             order by email`
        );
        const account = await pool.query(
            `select name, contact_name, contact_email, operations_contact_name, operations_contact_email,
                    billing_contact_name, billing_contact_email
             from owner_accounts where name='HEALTEA'`
        ).catch(() => ({ rows: [] }));
        const deliveries = await pool.query(
            `select to_addresses, cc_addresses, bcc_addresses, subject, sent_at
             from email_delivery_log
             where account_name='HEALTEA'
               and (
                    lower(coalesce(subject,'')) like '%landry%'
                    or lower(coalesce(to_addresses::text,'')) like '%landry%'
                    or lower(coalesce(cc_addresses::text,'')) like '%landry%'
                    or lower(coalesce(bcc_addresses::text,'')) like '%landry%'
               )
             order by created_at desc limit 20`
        );
        console.log(JSON.stringify({ portalUsers: portalUsers.rows, account: account.rows, matchingEmailHistory: deliveries.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
