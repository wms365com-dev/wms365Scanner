const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const result = await client.query(`
            select
                count(*)::integer as missing_shipments,
                count(*) filter (where o.fulfillment_location_id is null)::integer as missing_warehouse,
                count(*) filter (where o.fulfillment_location_id is not null and exists(select 1 from portal_order_lines l where l.order_id = o.id))::integer as safe_to_backfill,
                count(*) filter (where not exists(select 1 from portal_order_lines l where l.order_id = o.id))::integer as empty_orders,
                count(*) filter (where o.status = 'SHIPPED')::integer as shipped_orders,
                count(*) filter (where o.status in ('RELEASED','PICKED','STAGED'))::integer as active_orders
            from portal_orders o
            where o.status not in ('DRAFT', 'ARCHIVED')
              and not exists (select 1 from warehouse_shipments s where s.order_id = o.id)
        `);
        const samples = await client.query(`
            select o.id, o.order_code, o.account_name, o.status, o.fulfillment_location_id,
                   exists(select 1 from fulfillment_locations fl where fl.id = o.fulfillment_location_id) as warehouse_exists,
                   (select count(*)::integer from portal_order_lines l where l.order_id = o.id) as line_count,
                   (select count(*)::integer from portal_order_allocations a where a.order_id = o.id) as allocation_count
            from portal_orders o
            where o.status not in ('DRAFT', 'ARCHIVED')
              and not exists (select 1 from warehouse_shipments s where s.order_id = o.id)
            order by o.id desc
            limit 20
        `);
        console.log(JSON.stringify({ summary: result.rows[0], samples: samples.rows }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
