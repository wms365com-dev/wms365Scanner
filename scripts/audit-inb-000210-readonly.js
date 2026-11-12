"use strict";

const { Pool } = require("pg");

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const result = await pool.query(`
            select i.id,i.inbound_code,i.account_name,i.status,i.reference_number,i.carrier_name,
                   i.expected_date::text,i.received_at,i.fulfillment_location_id,
                   fl.code warehouse_code,fl.name warehouse_name,
                   l.id line_id,l.line_number,l.sku,l.expected_quantity,l.received_quantity,
                   l.received_location,l.lot_number,l.expiration_date::text,l.pallet_count,l.pallet_codes
            from portal_inbounds i
            join fulfillment_locations fl on fl.id=i.fulfillment_location_id
            join portal_inbound_lines l on l.inbound_id=i.id
            where i.inbound_code='INB-000210'
            order by l.line_number,l.id
        `);
        const row = result.rows[0];
        if (!row) throw new Error("INB-000210 was not found.");
        const bins = await pool.query(`
            select b.code,b.is_pickable,b.location_type,b.fulfillment_location_id,
                   coalesce(sum(case when inv.account_name=$1 and inv.sku = any($2::text[]) then inv.quantity else 0 end),0) quantity
            from bin_locations b
            left join inventory_lines inv on inv.location=b.code
            where b.fulfillment_location_id=$3
            group by b.code,b.is_pickable,b.location_type,b.fulfillment_location_id
            order by b.code
        `, [row.account_name, result.rows.map((line) => line.sku), row.fulfillment_location_id]);
        const recipients = await pool.query(`
            select email,notification_type,is_subscribed
            from customer_email_preferences
            where account_name=$1 and notification_type in ('RECEIPT_CONFIRMATION','INBOUND_RECEIVED')
            order by email
        `, [row.account_name]);
        const item = await pool.query(`select sku,tracking_level,unit_uom,units_per_case,lot_tracked,expiration_tracked,blocked
            from item_catalog where account_name=$1 and sku=$2`, [row.account_name, row.sku]);
        const documents = await pool.query(`select id,file_name,file_type,file_size,document_category
            from portal_inbound_documents where inbound_id=$1 order by id`, [row.id]);
        const contacts = await pool.query(`select count(*)::integer recipient_count from (
            select lower(email) email from portal_vendor_access where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>''
            union select lower(unnest(array[portal_login_email,billing_email,ap_email,email])) from owner_accounts where name=$1
        ) x where email is not null and email<>'' and email<>'support@wms365.co'`, [row.account_name]);
        console.log(JSON.stringify({ inbound: result.rows, item: item.rows, documents: documents.rows,
            bins: bins.rows, recipientPreferences: recipients.rows, recipientCount: contacts.rows[0]?.recipient_count || 0 }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
