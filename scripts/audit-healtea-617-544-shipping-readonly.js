const { Client } = require("pg");
async function main() {
    const client = new Client({ connectionString:process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,ssl:false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const orders = await client.query(`select order_code,status,shipment_method,confirmed_ship_date::text,
            shipped_carrier_name,shipped_tracking_reference,outbound_total_pallets,outbound_existing_pallets,outbound_new_pallets,order_notes
            from portal_orders where account_name='HEALTEA' and order_code=any($1::text[]) order by id`,[["ORD-000617","ORD-000544"]]);
        const documents = await client.query(`select o.order_code,d.file_name,d.document_category from portal_orders o
            join portal_order_documents d on d.order_id=o.id where o.account_name='HEALTEA' and o.order_code=any($1::text[]) order by o.id,d.id`,[["ORD-000617","ORD-000544"]]);
        const shippedLines = await client.query(`select o.order_code,l.sku,l.ordered_quantity,l.shipped_quantity
            from portal_orders o join portal_order_shipment_lines l on l.order_id=o.id
            where o.account_name='HEALTEA' and o.order_code=any($1::text[]) order by o.id,l.order_line_id`,[["ORD-000617","ORD-000544"]]);
        const warehouseShipments = await client.query(`select o.order_code,s.status,s.total_pallets from portal_orders o
            join warehouse_shipments s on s.order_id=o.id and s.account_name=o.account_name
            where o.account_name='HEALTEA' and o.order_code=any($1::text[]) order by o.id`,[["ORD-000617","ORD-000544"]]);
        const email = await client.query(`select status,message_id,bcc_addresses,sent_at from email_delivery_log
            where account_name='HEALTEA' and delivery_key='HEALTEA-617-544-SHIPPED-20260916'`);
        console.log(JSON.stringify({orders:orders.rows,documents:documents.rows,shippedLines:shippedLines.rows,warehouseShipments:warehouseShipments.rows,email:email.rows},null,2));
        await client.query("rollback");
    } finally {await client.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
