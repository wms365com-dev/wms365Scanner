const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const result = await client.query(
            `select o.order_code,o.status,o.cancelled_at,fl.code warehouse_code,
                    coalesce(sum(a.allocated_quantity),0)::integer reserved_units
             from portal_orders o
             join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             left join portal_order_allocations a on a.order_id=o.id
             where o.account_name=$1 and o.order_code=any($2::text[])
             group by o.id,fl.code order by o.order_code`,
            ["RANCHER'S CHIPS", ["ORD-000780", "ORD-000815"]]
        );
        console.log(JSON.stringify(result.rows, null, 2));
        if (result.rows.length !== 2 || result.rows.some((row) => row.status !== "CANCELLED" || row.reserved_units !== 0 || row.warehouse_code !== "GW3PL-MISS")) throw new Error("Cancellation verification failed.");
        await client.query("rollback");
    } finally { await client.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
