const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const [request, inventory, ledger, email] = await Promise.all([
            pool.query(
                `select request_code, account_name, status, completed_at, completed_by, warehouse_note
                 from portal_kitting_requests where request_code='KIT-000018'`
            ),
            pool.query(
                `select i.id, i.sku, i.location, i.quantity, i.tracking_level, i.lot_number,
                        i.expiration_date, i.updated_at, b.is_pickable, b.location_type,
                        b.fulfillment_location_id
                 from inventory_lines i
                 join bin_locations b on b.code=i.location
                 where i.account_name='HEALTEA'
                   and i.sku=any($1::text[])
                   and (i.id=any($2::bigint[]) or i.location='GW3PL-MISS-HEALTEA-BULK')
                 order by i.sku, i.id`,
                [["20628693486167", "TRAY12", "30628693486072"], [1235, 1236]]
            ),
            pool.query(
                `select id, sku, location, lot_number, expiration_date, transaction_type,
                        quantity_delta, quantity_before, quantity_after
                 from inventory_transactions
                 where account_name='HEALTEA'
                   and source_type='PORTAL_KITTING_REQUEST'
                   and source_id='KIT-000018'
                 order by id`
            ),
            pool.query(
                `select id, status, subject, bcc_addresses, message_id, sent_at, error_message
                 from email_delivery_log
                 where source_ref='KIT-000018'
                 order by id desc`
            )
        ]);
        console.log(JSON.stringify({
            request: request.rows[0] || null,
            inventory: inventory.rows,
            ledger: ledger.rows,
            email: email.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
