const { Client } = require("pg");

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await client.connect();
    try {
        await client.query("begin read only");
        const orderResult = await client.query(
            `select o.id, o.order_code, o.account_name, o.status, o.fulfillment_location_id,
                    f.code as warehouse_code
             from portal_orders o
             join fulfillment_locations f on f.id = o.fulfillment_location_id
             where o.order_code = $1`, ["ORD-001468"]
        );
        if (orderResult.rowCount !== 1) throw new Error("Order identity is not unique");
        const order = orderResult.rows[0];
        if (order.warehouse_code !== "GW3PL-MISS" || Number(order.fulfillment_location_id) !== 1) {
            throw new Error("Order is not assigned to pinned Mississauga warehouse");
        }
        const documents = await client.query(
            `select id, file_name, file_type, file_size, document_category
             from portal_order_documents where order_id = $1 order by id`, [order.id]
        );
        const stations = await client.query(
            `select s.id, s.station_name, s.status, s.is_active, s.last_seen_at,
                    p.id as printer_id, p.printer_name, p.printer_type, p.printer_role,
                    p.media_size, p.is_active as printer_active
             from warehouse_print_stations s
             left join warehouse_printers p on p.station_id = s.id
             where s.fulfillment_location_id = $1 order by s.id, p.id`, [order.fulfillment_location_id]
        );
        const jobs = await client.query(
            `select id, document_type, source_type, source_id, status, printer_id,
                    requested_at, completed_at
             from warehouse_print_jobs
             where source_type = 'PORTAL_ORDER' and source_id = $1
             order by id`, [String(order.id)]
        );
        await client.query("rollback");
        console.log(JSON.stringify({ order, documents: documents.rows,
            stations: stations.rows, jobs: jobs.rows }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
