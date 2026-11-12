const { Client } = require("pg");

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin transaction isolation level repeatable read read only");
        const order = (await db.query(`select o.id,o.order_code,o.account_name,o.status,o.confirmed_ship_date::text,
            o.shipped_at,o.shipped_carrier_name,o.shipment_email_status,o.shipment_email_sent_at,
            o.shipment_email_last_error,o.outbound_total_pallets,fl.code warehouse_code
            from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
            where o.order_code='ORD-001281'`)).rows;
        if (order.length !== 1 || order[0].account_name !== 'ZETA GROUP (CANADA) LTD.' || order[0].warehouse_code !== 'GW3PL-MISS') {
            throw new Error("Order identity verification failed.");
        }
        const orderId = order[0].id;
        const shipments = (await db.query(`select shipment_code,status,carrier_name,tracking_reference,total_pallets,
            shipped_at from warehouse_shipments where order_id=$1 order by id`, [orderId])).rows;
        const shipmentLines = (await db.query(`select l.sku,sl.shipped_quantity from warehouse_shipment_lines sl
            join warehouse_shipments s on s.id=sl.shipment_id
            join portal_order_lines l on l.id=sl.order_line_id where s.order_id=$1 order by l.sku`, [orderId])).rows;
        const ledger = (await db.query(`select sku,sum(quantity_delta)::integer quantity_delta,count(*)::integer entries
            from inventory_transactions where account_name='ZETA GROUP (CANADA) LTD.'
            and source_type='PORTAL_ORDER' and source_id=$1::text group by sku order by sku`, [orderId])).rows;
        const billing = (await db.query(`select fee_code,quantity,amount,currency_code,status,source_ref
            from billing_events where account_name='ZETA GROUP (CANADA) LTD.' and source_ref in ($1::text,'ORD-001281') order by id`, [orderId])).rows;
        const documents = (await db.query(`select document_category,file_name from portal_order_documents
            where order_id=$1 order by id`, [orderId])).rows;
        const email = (await db.query(`select status,to_addresses,cc_addresses,bcc_addresses,subject,sent_at
            from email_delivery_log where account_name='ZETA GROUP (CANADA) LTD.'
            and source_type='SHIPMENT_CONFIRMATION' and source_ref='ORD-001281' order by id desc limit 1`)).rows[0] || null;
        await db.query("rollback");
        console.log(JSON.stringify({ order: order[0], shipments, shipmentLines, ledger, billing, documents,
            email: email ? { status: email.status, toCount: email.to_addresses.length, ccCount: email.cc_addresses.length,
                bccCount: email.bcc_addresses.length, subject: email.subject, sentAt: email.sent_at } : null }, null, 2));
    } catch (error) { await db.query("rollback").catch(() => {}); throw error; }
    finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
