const { Pool } = require("pg");

const DELIVERY_DATE = process.argv[2] || "2026-10-19";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, max: 1 });
    try {
        const result = await pool.query(`
            select o.id, o.order_code, o.account_name, o.status, o.po_number,
                   o.requested_ship_date::text, o.routing_requested_delivery_date::text,
                   o.ship_to_name, o.ship_to_address1, o.ship_to_postal_code,
                   o.shipped_at, o.routed_at,
                   e.status as email_status, e.subject, e.message_id,
                   r.status as appointment_status
            from portal_orders o
            left join email_delivery_log e on e.delivery_key = concat('order-routing:', o.id)
            left join order_routing_requests r on r.order_id = o.id
            where o.account_name = 'ALCONA TRADING LTD'
              and coalesce(o.routing_requested_delivery_date, o.requested_ship_date) = $1::date
            order by o.id
        `, [DELIVERY_DATE]);
        console.log(JSON.stringify({ deliveryDate: DELIVERY_DATE, orders: result.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
