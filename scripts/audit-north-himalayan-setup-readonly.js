const { Client } = require("pg");

const COMPANY_SEARCH = "%NORTH HIMALAYAN%";
const EMAILS = ["info@northhimalayantraders.com", "atif.raza55@yahoo.com"];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const [companies, users, warehouses, assignments, locationExamples, emails] = await Promise.all([
            client.query(
                `select name, legal_name, email, portal_login_email, is_active
                 from owner_accounts
                 where upper(name) like $1 or upper(legal_name) like $1
                    or lower(email) = any($2::text[]) or lower(portal_login_email) = any($2::text[])`,
                [COMPANY_SEARCH, EMAILS]
            ),
            client.query(
                `select account_name, email, is_active
                 from portal_vendor_access
                 where lower(email) = any($1::text[]) or upper(account_name) like $2`,
                [EMAILS, COMPANY_SEARCH]
            ),
            client.query(
                `select id, code, name, partner_name, address1, city, state, postal_code, country, is_active
                 from fulfillment_locations
                 where upper(code) like '%EDW%' or upper(name) like '%EDWARD%'
                 order by is_active desc, code`,
                []
            ),
            client.query(
                `select c.account_name, c.is_primary, c.allow_inbound, c.allow_outbound,
                        c.allow_storage, c.allow_returns, f.code as warehouse_code, f.name as warehouse_name
                 from company_fulfillment_locations c
                 join fulfillment_locations f on f.id = c.fulfillment_location_id
                 where c.account_name = 'NORTH HIMALAYAN TRADERS'
                 order by f.code`,
                []
            ),
            client.query(
                `select b.code, b.account_name, b.location_type, b.is_pickable, f.code as warehouse_code
                 from bin_locations b
                 join fulfillment_locations f on f.id = b.fulfillment_location_id
                 where (upper(f.code) like '%EDW%' or upper(f.name) like '%EDWARD%')
                 order by b.updated_at desc, b.code
                 limit 80`,
                []
            ),
            client.query(
                `select status, provider, to_addresses, cc_addresses, bcc_addresses, subject, message_id, sent_at
                 from email_delivery_log
                 where account_name = 'NORTH HIMALAYAN TRADERS' and source_type = 'PORTAL_ACCESS'
                 order by created_at desc
                 limit 3`,
                []
            )
        ]);
        console.log(JSON.stringify({
            ok: true,
            existingCompanies: companies.rows,
            existingPortalUsers: users.rows,
            edwardsWarehouses: warehouses.rows,
            companyWarehouseAssignments: assignments.rows,
            customerLocationExamples: locationExamples.rows,
            portalAccessEmails: emails.rows
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
