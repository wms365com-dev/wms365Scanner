const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const result = await client.query(`
            select o.order_code,o.status,o.shipment_method,o.shipped_carrier_name,
                   o.shipped_tracking_reference,o.confirmed_ship_date,o.outbound_total_pallets,
                   d.id document_id,d.file_name,d.document_category,d.file_type
            from portal_orders o left join portal_order_documents d on d.order_id=o.id
            where o.account_name='HEALTEA' and o.order_code=any($1::text[])
            order by o.order_code,d.id`, [["ORD-000606", "ORD-000543"]]);
        console.log(JSON.stringify(result.rows, null, 2));
        const quantities = await client.query(`select o.order_code,l.sku,l.shipped_quantity
            from portal_order_shipment_lines l join portal_orders o on o.id=l.order_id
            where o.account_name='HEALTEA' and o.order_code=any($1::text[])
            order by o.order_code,l.order_line_id`, [["ORD-000606", "ORD-000543"]]);
        console.log(JSON.stringify({ shippedLines: quantities.rows }, null, 2));
        await client.query("rollback");
    } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
