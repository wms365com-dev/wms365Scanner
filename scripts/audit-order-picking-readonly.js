const { Client } = require("pg");

async function main() {
    const code = process.argv[2];
    if (!/^ORD-\d{6}$/.test(code || "")) throw new Error("A valid WMS order code is required.");
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const orders = await client.query(
            `select o.id,o.order_code,o.account_name,o.status,o.picked_at,o.staged_at,fl.code warehouse
             from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1`, [code]
        );
        if (orders.rowCount !== 1) throw new Error("Expected one unique order.");
        const order = orders.rows[0];
        const lines = await client.query(
            `select l.id,l.sku,l.requested_quantity,c.description,c.tracking_level,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_line_id=l.id),0)::integer allocated,
                    coalesce((select sum(p.quantity) from pick_confirmations p where p.line_id=l.id and p.sync_status<>'FAILED'),0)::integer confirmed
             from portal_order_lines l left join item_catalog c on c.account_name=$2 and c.sku=l.sku
             where l.order_id=$1 order by l.line_number,l.id`, [order.id, order.account_name]
        );
        const tasks = await client.query("select id,task_type,status,blocked_reason,metadata from warehouse_tasks where source_type='PORTAL_ORDER' and source_id=$1 order by id", [order.id]);
        console.log(JSON.stringify({ order, lines: lines.rows, tasks: tasks.rows }, null, 2));
        await client.query("rollback");
    } finally { await client.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
