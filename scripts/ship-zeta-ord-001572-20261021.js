"use strict";
const fs=require("fs");
const {APP_USER_ROLES,updateAdminPortalOrderStatus,withTransaction}=require("../server");
const {getPortalShipmentEmailAddressing}=require("../shipment-email-addressing");
const CODE="ORD-001572",ACCOUNT="ZETA GROUP (CANADA) LTD.",WAREHOUSE="GW3PL-MISS",SHIP_DATE="2026-10-21",CARRIER="VITRAN",BOL="SYYZOD511572";
const APPLY=process.argv.includes("--apply"),BOL_PATH=process.env.SOURCE_BOL_PATH||"",LOAD_PATH=process.env.SOURCE_LOAD_PATH||"";
const EXPECTED=new Map([["S624A",6],["S624G",5],["S624H",5],["S624I",5],["S624J",5],["S624D",5],["S044",1],["S043",1],["S400S",3],["S400O",3],["S158",2],["S160",1],["S624F",1]]);
const ACTOR={id:null,email:"wms365-operations@wms365.co",full_name:"WMS365 Operations - Owner Approved Shipment",role:APP_USER_ROLES.SUPER_ADMIN};

async function facts(c,lock=false){
 const q=await c.query(`select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipping_reference,o.shipment_method,o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,o.shipped_tracking_reference,o.shipment_email_status,o.outbound_total_pallets,o.outbound_existing_pallets,o.outbound_new_pallets,o.routing_total_weight,o.routing_weight_uom,fl.code warehouse_code from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1${lock?" for update of o":""}`,[CODE]);
 if(q.rowCount!==1)throw Error(`Expected one exact ${CODE}.`);const order=q.rows[0];
 if(order.account_name!==ACCOUNT||order.warehouse_code!==WAREHOUSE||order.po_number!=="9017998")throw Error("Company, warehouse, or PO identity mismatch.");
 if(!["STAGED","SHIPPED"].includes(order.status))throw Error(`Expected STAGED or SHIPPED, found ${order.status}.`);
 const lines=(await c.query(`select l.id,l.sku,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id where l.order_id=$1 group by l.id,l.sku,l.requested_quantity order by l.id`,[order.id])).rows;
 if(lines.length!==EXPECTED.size||lines.some(x=>EXPECTED.get(x.sku)!==Number(x.requested_quantity)))throw Error("Order lines no longer match the reviewed staged order.");
 if(order.status!=="SHIPPED"&&lines.some(x=>Number(x.allocated_quantity)!==Number(x.requested_quantity)))throw Error("Order is not fully allocated.");
 const recipients=(await c.query(`select distinct lower(trim(email)) email from (select email from portal_vendor_access where account_name=$1 and is_active=true union all select portal_login_email from owner_accounts where name=$1 union all select billing_email from owner_accounts where name=$1 union all select ap_email from owner_accounts where name=$1)r where trim(coalesce(email,''))<>'' order by 1`,[ACCOUNT])).rows.map(x=>x.email);
 if(!recipients.length)throw Error("No active Zeta shipment-confirmation recipients are configured.");
 const addressing=getPortalShipmentEmailAddressing({accountName:ACCOUNT,orderCode:CODE},recipients,"support@wms365.co"),bccCount=String(addressing.bcc||"").split(",").map(x=>x.trim()).filter(Boolean).length;
 if(addressing.to!=="support@wms365.co"||bccCount!==recipients.length||String(addressing.cc||"").trim())throw Error("Live Zeta shipment email addressing is not BCC-only.");
 const documents=(await c.query("select id,file_name,document_category from portal_order_documents where order_id=$1 order by id",[order.id])).rows;
 const shipments=(await c.query("select id,status,carrier_name,tracking_reference,bol_reference,total_pallets,existing_pallets,new_pallets,mixed_pallets,total_weight,weight_uom,shipped_at from warehouse_shipments where order_id=$1 order by id",[order.id])).rows;
 return{order,lines,documents,shipments,recipientCount:recipients.length};
}
function summary(s){return{order:s.order,lines:s.lines.map(x=>({sku:x.sku,ordered:Number(x.requested_quantity),allocated:Number(x.allocated_quantity)})),documentCategories:s.documents.map(x=>x.document_category),shipments:s.shipments,recipientCount:s.recipientCount,addressing:"SYSTEM_TO_WITH_COMPANY_RECIPIENTS_BCC_ONLY"}}

async function main(){
 const before=await withTransaction(async c=>{await c.query("set transaction read only");return facts(c)});
 console.log(JSON.stringify({phase:"preflight",evidence:{shipDate:SHIP_DATE,carrier:CARRIER,bolNumber:BOL,pallets:1,weight:300,weightUom:"LB"},...summary(before)}));if(!APPLY)return;
 if(before.order.status==="SHIPPED"){console.log(JSON.stringify({phase:"no-op",reason:"already-shipped",...summary(before)}));return}
 if(!BOL_PATH||!LOAD_PATH||!fs.existsSync(BOL_PATH)||!fs.existsSync(LOAD_PATH))throw Error("Both reviewed shipment images are required.");
 const bol=fs.readFileSync(BOL_PATH),load=fs.readFileSync(LOAD_PATH);if(bol.subarray(0,2).toString("hex")!=="ffd8"||load.subarray(0,2).toString("hex")!=="ffd8")throw Error("Shipment evidence must be JPEG files.");
 await withTransaction(async c=>{const s=await facts(c,true);if(s.order.status==="SHIPPED")return;
  await c.query("update portal_orders set routing_total_weight=300,routing_weight_uom='LB',updated_at=now() where id=$1",[s.order.id]);
  await updateAdminPortalOrderStatus(c,s.order.id,"SHIPPED",{idempotencyKey:"owner-zeta-ord-001572-shipped-20261021",confirmedShipDate:SHIP_DATE,shipmentMethod:"LTL_FREIGHT",carrierName:CARRIER,trackingReference:BOL,packingSlipQuantityConfirmed:true,missingShipmentProofOverride:true,missingShipmentProofOverrideReason:"Owner supplied a signed carrier BOL and loaded-shipment photo and explicitly instructed WMS365 to close ORD-001572 on October 27, 2026; no separate checked packing slip was supplied.",note:"Owner-provided signed VITRAN BOL confirms pickup on October 21, 2026. BOL SYYZOD511572. One skid, 300 lb. Loaded photo identifies ORD-001572 pallet 1/1.",outboundPallets:{totalPalletsOut:1,existingPalletsOut:1,newPalletsUsed:0,mixedPalletsBuilt:1,palletNote:"One loaded skid, 300 lb, verified from signed BOL and loaded photo."},shippedLines:s.lines.map(x=>({orderLineId:x.id,sku:x.sku,shippedQuantity:Number(x.requested_quantity)})),documents:[{fileName:`${CODE}-signed-bol.jpeg`,fileType:"image/jpeg",documentCategory:"SHIPMENT_BOL",dataUrl:`data:image/jpeg;base64,${bol.toString("base64")}`},{fileName:`${CODE}-loaded.jpeg`,fileType:"image/jpeg",documentCategory:"SHIPMENT_LOAD_PHOTO",dataUrl:`data:image/jpeg;base64,${load.toString("base64")}`}]},ACTOR);
  await c.query("update warehouse_shipments set bol_reference=$2,total_pallets=1,existing_pallets=1,new_pallets=0,mixed_pallets=1,total_weight=300,weight_uom='LB',updated_at=now() where order_id=$1",[s.order.id,BOL]);
 });
 const after=await withTransaction(async c=>{await c.query("set transaction read only");const s=await facts(c);const shippedLines=(await c.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku",[s.order.id])).rows;const ledger=(await c.query("select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING' group by sku order by sku",[ACCOUNT,String(s.order.id)])).rows;return{...s,shippedLines,ledger}});
 const shipment=after.shipments[0];
 if(after.order.status!=="SHIPPED"||after.order.confirmed_ship_date!==SHIP_DATE||after.order.shipped_carrier_name!==CARRIER||after.order.shipped_tracking_reference!==BOL||Number(after.order.outbound_total_pallets)!==1||Number(after.order.routing_total_weight)!==300)throw Error("Post-shipment order verification failed.");
 if(after.shippedLines.length!==EXPECTED.size||after.shippedLines.some(x=>Number(x.shipped_quantity)!==EXPECTED.get(x.sku)))throw Error("Post-shipment line verification failed.");
 if(after.ledger.length!==EXPECTED.size||after.ledger.some(x=>-Number(x.quantity_delta)!==EXPECTED.get(x.sku)))throw Error("Inventory shipping ledger verification failed.");
 if(!after.documents.some(x=>x.document_category==="SHIPMENT_BOL")||!after.documents.some(x=>x.document_category==="SHIPMENT_LOAD_PHOTO"))throw Error("Shipment evidence verification failed.");
 if(after.shipments.length!==1||shipment.status!=="SHIPPED"||shipment.bol_reference!==BOL||Number(shipment.total_pallets)!==1||Number(shipment.total_weight)!==300||shipment.weight_uom!=="LB")throw Error("Warehouse shipment verification failed.");
 console.log(JSON.stringify({phase:"verified",shippedLines:after.shippedLines,ledger:after.ledger,...summary(after)}));
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(()=>setTimeout(()=>process.exit(process.exitCode||0),100));
