const { Pool } = require("pg");
const ACCOUNT = "WELLFORIA HEALTH INC";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const [orders, users] = await Promise.all([
            pool.query(
                `select o.order_code,o.status,o.portal_access_id,p.email,p.is_active,l.sku,l.requested_quantity
                 from portal_orders o join portal_order_lines l on l.order_id=o.id
                 left join portal_vendor_access p on p.id=o.portal_access_id
                 where o.account_name=$1 and o.order_code between 'S-ORD101184' and 'S-ORD101211'
                 order by o.order_code`,
                [ACCOUNT]
            ),
            pool.query(
                `select id,email,is_active
                 from portal_vendor_access where account_name=$1 order by is_active desc,id`,
                [ACCOUNT]
            )
        ]);
        console.log(JSON.stringify({ mode: "READ_ONLY", account: ACCOUNT, orders: orders.rows, portalUsers: users.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
