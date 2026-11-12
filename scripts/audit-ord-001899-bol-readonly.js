const { Pool } = require("pg");

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const result = await pool.query(`
            select o.id,o.order_code,o.account_name,o.status,o.po_number,o.fulfillment_location_id,
                   o.ship_to_name,o.ship_to_address1,o.ship_to_postal_code,o.shipped_at,
                   s.id shipment_id,s.status shipment_status,s.carrier_name,s.delivery_date::text,
                   r.id routing_id,r.status appointment_status,r.appointment_date::text,
                   r.window_start::text,r.window_end::text,r.responded_at,
                   (select count(*)::int from portal_order_lines l where l.order_id=o.id) line_count,
                   (select count(*)::int from portal_order_allocations a where a.order_id=o.id) allocation_count,
                   (select count(*)::int from portal_order_documents d
                    where d.order_id=o.id and d.document_category='SHIPMENT_BOL') bol_count
            from portal_orders o
            left join warehouse_shipments s on s.order_id=o.id
            left join order_routing_requests r on r.order_id=o.id
            where o.order_code='ORD-001899'
        `);
        if (result.rowCount !== 1) throw new Error("ORD-001899 identity is not unique.");
        console.log(JSON.stringify(result.rows[0], null, 2));
    } finally {
        await pool.end();
    }
}
main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
