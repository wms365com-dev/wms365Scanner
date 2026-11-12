"use strict";
const { Client } = require("pg");
const ORDER_CODE = process.argv.find((value) => /^ORD-\d{6}$/.test(value)) || "ORD-001697";

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        const order = (await db.query(
            `select o.id,o.order_code,o.account_name,o.status,o.confirmed_ship_date::text,o.shipped_at,
                    o.shipped_carrier_name,o.shipped_tracking_reference,o.shipment_email_status,
                    o.shipment_email_sent_at,o.shipment_email_last_error,o.outbound_total_pallets,
                    o.outbound_existing_pallets,o.outbound_new_pallets,o.routing_total_weight,o.routing_weight_uom,
                    fl.code warehouse_code
             from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1`, [ORDER_CODE]
        )).rows[0];
        if (!order || order.account_name !== "ZETA GROUP (CANADA) LTD.") throw new Error("Exact order identity not verified.");
        const [shippedLines, ledger, docs, shipment, email] = await Promise.all([
            db.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku", [order.id]),
            db.query(`select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions
                      where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING'
                      group by sku order by sku`, [order.account_name, String(order.id)]),
            db.query("select file_name,document_category from portal_order_documents where order_id=$1 order by id", [order.id]),
            db.query(`select status,carrier_name,tracking_reference,bol_reference,total_pallets,existing_pallets,
                             new_pallets,mixed_pallets,total_weight,weight_uom,shipped_at
                      from warehouse_shipments where order_id=$1 order by id`, [order.id]),
            db.query(`select status,to_addresses,cc_addresses,bcc_addresses,subject,message_id,sent_at,error_message
                      from email_delivery_log where account_name=$1 and source_type='SHIPMENT_CONFIRMATION'
                        and source_ref=$2 order by id desc limit 1`, [order.account_name, ORDER_CODE])
        ]);
        await db.query("rollback");
        const emailRow = email.rows[0] || null;
        const count = (value) => String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean).length;
        console.log(JSON.stringify({
            order,
            shippedLines: shippedLines.rows,
            ledger: ledger.rows,
            documents: docs.rows,
            shipment: shipment.rows,
            email: emailRow ? {
                status: emailRow.status,
                systemTo: String(emailRow.to_addresses || "").toLowerCase() === "support@wms365.co",
                toCount: count(emailRow.to_addresses),
                ccCount: count(emailRow.cc_addresses),
                bccCount: count(emailRow.bcc_addresses),
                hasMessageId: Boolean(emailRow.message_id),
                sentAt: emailRow.sent_at,
                hasError: Boolean(emailRow.error_message)
            } : null
        }));
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
