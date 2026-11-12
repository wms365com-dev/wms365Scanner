const { Client } = require("pg");

const CODES = ["INB-000197", "INB-000198", "INB-000199"];

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const inbounds = await client.query(
            `select i.id,i.inbound_code,i.account_name,i.status,i.reference_number,i.expected_date,
                    i.received_at,i.fulfillment_location_id,fl.code warehouse_code,i.notes
             from portal_inbounds i join fulfillment_locations fl on fl.id=i.fulfillment_location_id
             where i.inbound_code=any($1::text[]) order by i.inbound_code`, [CODES]
        );
        const ids = inbounds.rows.map(row => row.id);
        const lines = await client.query(
            `select l.inbound_id,l.id line_id,l.line_number,l.sku,l.expected_quantity,l.received_quantity,
                    l.received_location,l.lot_number,l.expiration_date::text,l.pallet_count,
                    c.description,c.tracking_level,c.lot_tracked,c.expiration_tracked,c.blocked
             from portal_inbound_lines l left join item_catalog c on c.account_name='HEALTEA' and c.sku=l.sku
             where l.inbound_id=any($1::bigint[]) order by l.inbound_id,l.line_number,l.id`, [ids]
        );
        const recipients = await client.query(
            `select email,is_active from portal_vendor_access
             where account_name='HEALTEA' order by email`
        );
        console.log(JSON.stringify({ inbounds: inbounds.rows, lines: lines.rows, recipients: recipients.rows }, null, 2));
        await client.query("rollback");
    } finally {
        await client.end();
    }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
