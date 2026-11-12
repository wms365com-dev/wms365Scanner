const { Client } = require("pg");
async function main() {
    const client = new Client({ connectionString:process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,ssl:false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const order = await client.query(`select order_code,status,confirmed_ship_date::text,shipped_carrier_name,shipped_tracking_reference,
            outbound_total_pallets,shipped_confirmation_note,shipment_email_status from portal_orders where order_code='ORD-000557' and account_name='HEALTEA'`);
        const shipments = await client.query(`select s.status,s.total_pallets,sum(l.ordered_quantity)::integer ordered_cases,sum(l.shipped_quantity)::integer shipped_cases
            from warehouse_shipments s join warehouse_shipment_lines l on l.shipment_id=s.id
            where s.account_name='HEALTEA' and s.order_id=(select id from portal_orders where order_code='ORD-000557' and account_name='HEALTEA')
            group by s.id`);
        const email = await client.query(`select status,provider,message_id,to_addresses,cc_addresses,bcc_addresses,sent_at
            from email_delivery_log where delivery_key='HEALTEA-ORD557-SHIPPED-SHORT24-20260916' and account_name='HEALTEA'`);
        console.log(JSON.stringify({order:order.rows,shipments:shipments.rows,email:email.rows},null,2));
        await client.query("rollback");
    } finally {await client.end();}
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
