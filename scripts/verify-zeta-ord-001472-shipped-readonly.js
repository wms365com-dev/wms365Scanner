"use strict";
const {Client}=require("pg");
async function main(){
 const db=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL,ssl:false});await db.connect();
 try{
  await db.query("begin transaction isolation level repeatable read read only");
  const orders=(await db.query(`select o.id,o.order_code,o.account_name,o.status,o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,o.shipment_email_status,o.shipment_email_sent_at,o.shipment_email_last_error,o.outbound_total_pallets,o.outbound_existing_pallets,o.outbound_new_pallets,fl.code warehouse_code from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code='ORD-001472'`)).rows;
  if(orders.length!==1||orders[0].account_name!=="ZETA GROUP (CANADA) LTD."||orders[0].warehouse_code!=="GW3PL-MISS")throw Error("Order identity verification failed.");
  const o=orders[0],id=o.id;
  const shipments=(await db.query("select shipment_code,status,carrier_name,tracking_reference,total_pallets,total_weight,weight_uom,shipped_at from warehouse_shipments where order_id=$1 order by id",[id])).rows;
  const shipmentLines=(await db.query("select l.sku,l.requested_quantity,sl.shipped_quantity from warehouse_shipment_lines sl join warehouse_shipments s on s.id=sl.shipment_id join portal_order_lines l on l.id=sl.order_line_id where s.order_id=$1 order by l.sku",[id])).rows;
  const ledger=(await db.query("select sku,sum(quantity_delta)::integer quantity_delta,count(*)::integer entries from inventory_transactions where account_name=$1 and source_type='PORTAL_ORDER' and source_id=$2::text group by sku order by sku",[o.account_name,id])).rows;
  const billing=(await db.query("select fee_code,quantity,amount,currency_code,status,source_ref from billing_events where account_name=$1 and source_ref in ($2::text,'ORD-001472') order by id",[o.account_name,id])).rows;
  const documents=(await db.query("select document_category,file_name from portal_order_documents where order_id=$1 order by id",[id])).rows;
  const email=(await db.query("select status,to_addresses,cc_addresses,bcc_addresses,subject,message_id,sent_at,error_message from email_delivery_log where account_name=$1 and source_type='SHIPMENT_CONFIRMATION' and source_ref='ORD-001472' order by id desc limit 1",[o.account_name])).rows[0]||null;
  await db.query("rollback");
  console.log(JSON.stringify({order:o,shipments,shipmentLines,ledger,billing,documents,email:email?{status:email.status,toCount:email.to_addresses.length,ccCount:email.cc_addresses.length,bccCount:email.bcc_addresses.length,subject:email.subject,messageIdPresent:Boolean(email.message_id),sentAt:email.sent_at,error:email.error_message||""}:null}));
 }catch(e){await db.query("rollback").catch(()=>{});throw e}finally{await db.end()}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
