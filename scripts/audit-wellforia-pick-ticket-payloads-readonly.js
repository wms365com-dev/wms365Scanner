const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const jobs = await client.query(
            `select id,source_ref,document_type,file_name,status,requested_at,completed_at,last_error,
                    length(payload_base64) payload_chars,
                    md5(decode(payload_base64,'base64')) payload_md5,
                    convert_from(decode(payload_base64,'base64'),'UTF8') like '%UPC: %' has_separate_upc,
                    convert_from(decode(payload_base64,'base64'),'UTF8') like '% | UPC %' has_inline_upc,
                    convert_from(decode(payload_base64,'base64'),'UTF8') like '%WMS365 PICK TICKET%' has_pick_ticket_title
             from warehouse_print_jobs
             where account_name='WELLFORIA HEALTH INC'
               and document_type='PICK_TICKET'
               and requested_at >= timestamptz '2026-10-06 00:00:00-04'
             order by requested_at desc,id desc limit 30`
        );
        console.log(JSON.stringify({ jobs: jobs.rows }, null, 2));
        await client.query("rollback");
    } finally {
        await client.end();
    }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
