"use strict";
const fs=require("fs");
const {APP_USER_ROLES,updateAdminPortalOrderStatus,withTransaction}=require("../server");
const {getPortalShipmentEmailAddressing}=require("../shipment-email-addressing");
const CODE="ORD-001403",ACCOUNT="ZETA GROUP (CANADA) LTD.",WAREHOUSE="GW3PL-MISS",PO="10.01.26 WCK";
const SHIP_DATE="2026-10-15",CARRIER="VITRAN",REFERENCE="941950230";
const SOURCE=process.env.SOURCE_PDF_PATH||"",APPLY=process.argv.includes("--apply");
const EXPECTED=new Map([["S158",8],["S160",6],["S161",6],["S164",6],["S165",10],["S166",6],["S044",4],["S043",5],["S041",16],["S472A",6]]);
const ACTOR={id:null,email:"wms365-operations@wms365.co",full_name:"WMS365 Operations - Owner Approved Shipment",role:APP_USER_ROLES.SUPER_ADMIN};

async function facts(client,lock=false){
 const q=await client.query(`select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipment_method,o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,o.shipped_tracking_reference,o.shipment_email_status,o.outbound_total_pallets,o.outbound_existing_pallets,o.outbound_new_pallets,fl.code warehouse_code from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1${lock?" for update of o":""}`,[CODE]);
 if(q.rowCount!==1)throw Error("Expected one exact order.");const order=q.rows[0];
 if(order.account_name!==ACCOUNT||order.warehouse_code!==WAREHOUSE||String(order.po_number)!==PO)throw Error("Company, warehouse, or PO identity mismatch.");
 if(!["STAGED","SHIPPED"].includes(order.status))throw Error(`Expected STAGED or SHIPPED, found ${order.status}.`);
 const lines=(await client.query(`select l.id,l.sku,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id where l.order_id=$1 group by l.id,l.sku,l.requested_quantity order by l.id`,[order.id])).rows;
 if(lines.length!==EXPECTED.size||lines.some(x=>EXPECTED.get(x.sku)!==Number(x.requested_quantity)))throw Error("Order lines do not match the reviewed packing slip.");
 if(order.status!=="SHIPPED"&&lines.some(x=>Number(x.allocated_quantity)!==Number(x.requested_quantity)))throw Error("Order is not fully allocated.");
 const recipients=(await client.query(`select distinct lower(trim(email)) email from (select email from portal_vendor_access where account_name=$1 and is_active=true union all select portal_login_email from owner_accounts where name=$1 union all select billing_email from owner_accounts where name=$1 union all select ap_email from owner_accounts where name=$1)r where trim(coalesce(email,''))<>'' order by 1`,[ACCOUNT])).rows.map(x=>x.email);
 if(!recipients.length)throw Error("No active Zeta recipients configured.");
 const addressing=getPortalShipmentEmailAddressing({accountName:ACCOUNT,orderCode:CODE},recipients,"support@wms365.co");
 if(addressing.to!=="support@wms365.co"||!addressing.bcc||addressing.cc)throw Error("Deployed Zeta addressing is not BCC-only.");
 const documents=(await client.query("select id,file_name,document_category from portal_order_documents where order_id=$1 order by id",[order.id])).rows;
 return{order,lines,recipients,documents};
}
function summary(s){return{order:s.order,lines:s.lines.map(x=>({sku:x.sku,ordered:Number(x.requested_quantity),allocated:Number(x.allocated_quantity)})),recipientCount:s.recipients.length,documentCategories:s.documents.map(x=>x.document_category)}}
async function main(){
 const before=await withTransaction(async c=>{await c.query("set transaction read only");return facts(c)});
 console.log(JSON.stringify({phase:"preflight",...summary(before)}));if(!APPLY)return;
 if(before.order.status==="SHIPPED"){console.log(JSON.stringify({phase:"no-op",reason:"already-shipped",...summary(before)}));return}
 if(!SOURCE||!fs.existsSync(SOURCE))throw Error("Reviewed shipment PDF unavailable.");const bytes=fs.readFileSync(SOURCE);
 if(bytes.subarray(0,4).toString()!=="%PDF")throw Error("Shipment evidence is not a PDF.");
 await withTransaction(async c=>{const s=await facts(c,true);if(s.order.status==="SHIPPED")return;const encoded=bytes.toString("base64");
  const documents=[
   {fileName:"ORD-001403-signed-vitran-bol.pdf",fileType:"application/pdf",documentCategory:"SHIPMENT_BOL",dataUrl:`data:application/pdf;base64,${encoded}`},
   {fileName:"ORD-001403-checked-packing-slip.pdf",fileType:"application/pdf",documentCategory:"SHIPMENT_PACKING_SLIP",dataUrl:`data:application/pdf;base64,${encoded}`},
   {fileName:"ORD-001403-loaded-shipment-photos.pdf",fileType:"application/pdf",documentCategory:"SHIPMENT_LOAD_PHOTO",dataUrl:`data:application/pdf;base64,${encoded}`}
  ];
  await updateAdminPortalOrderStatus(c,s.order.id,"SHIPPED",{idempotencyKey:"owner-zeta-ord-001403-shipped-20261015",confirmedShipDate:SHIP_DATE,shipmentMethod:"LTL_FREIGHT",carrierName:CARRIER,trackingReference:REFERENCE,packingSlipQuantityConfirmed:true,note:"Signed Vitran BOL, checked packing slip, checked pick ticket, and loaded trailer photo confirm all ten order lines.",outboundPallets:{totalPalletsOut:2,existingPalletsOut:2,newPalletsUsed:0,mixedPalletsBuilt:2,palletNote:"Two loaded pallets, 1,300 LB total, verified from signed BOL and shipment photo."},shippedLines:s.lines.map(x=>({orderLineId:x.id,sku:x.sku,shippedQuantity:Number(x.requested_quantity)})),documents},ACTOR);
 });
 const after=await withTransaction(async c=>{await c.query("set transaction read only");return facts(c)});
 if(after.order.status!=="SHIPPED"||String(after.order.confirmed_ship_date).slice(0,10)!==SHIP_DATE||String(after.order.shipped_carrier_name).toUpperCase()!==CARRIER||String(after.order.shipped_tracking_reference)!==REFERENCE||Number(after.order.outbound_total_pallets)!==2||Number(after.order.outbound_existing_pallets)!==2||Number(after.order.outbound_new_pallets)!==0)throw Error("Post-shipment verification failed.");
 console.log(JSON.stringify({phase:"verified",...summary(after)}));
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(()=>setTimeout(()=>process.exit(process.exitCode||0),100));
