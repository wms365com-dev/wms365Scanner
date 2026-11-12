"use strict";
const crypto=require("node:crypto");
const {Client}=require("pg");
const APPLY=process.argv.includes("--apply");
const CODE="ORD-001698",ACCOUNT="ALCONA TRADING LTD",FILE="WMS365_BOL_ORD-001698_2026-10-27_11AM.pdf";
const KEY="owner-ord-001698-bol-dhruv-20261027-11am-v1",FROM="WMS365 <support@wms365.co>";
const TO=["support@wms365.co"],CC=[],BCC=["d.jain@emotrans-canada.com"];
const SUBJECT="Pre-shipment BOL - Alcona ORD-001698 / PO 529673 - Oct 27, 11 AM delivery";
const HASH="dccee085933c604d1d00e7b27856ab4ea64a64483c91d898550212b071fa7956";
async function main(){
  if(!process.env.RESEND_API_KEY)throw Error("Email provider unavailable");
  const db=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL,ssl:false});await db.connect();let logId;
  try{await db.query("begin");const q=await db.query(`select o.id,o.account_name,o.status,o.shipped_at,o.fulfillment_location_id,o.po_number,
    o.shipped_carrier_name,o.routing_total_weight,o.routing_weight_uom,o.picked_pallet_details,s.status shipment_status,
    s.carrier_name shipment_carrier,s.total_pallets,s.total_weight shipment_weight,s.weight_uom shipment_weight_uom,
    s.delivery_date::text,r.status appointment_status,r.appointment_date::text appointment_date,r.window_start::text,
    d.id document_id,d.file_data from portal_orders o join warehouse_shipments s on s.order_id=o.id
    join order_routing_requests r on r.order_id=o.id join portal_order_documents d on d.order_id=o.id
    and d.file_name=$2 and d.document_category='SHIPMENT_BOL' where o.order_code=$1 for update of o,s`,[CODE,FILE]);
    if(q.rowCount!==1)throw Error("Order, shipment, routing request, or BOL identity is not unique");const o=q.rows[0];
    if(o.account_name!==ACCOUNT||o.status!=="STAGED"||o.shipment_status!=="STAGED"||o.shipped_at
      ||String(o.fulfillment_location_id)!=="143"||o.po_number!=="529673"||o.shipped_carrier_name!=="Bison"
      ||o.shipment_carrier!=="Bison"||Number(o.total_pallets)!==4||Number(o.routing_total_weight)!==4208.88
      ||Number(o.shipment_weight)!==4208.88||o.routing_weight_uom!=="KG"||o.shipment_weight_uom!=="KG"
      ||String(o.delivery_date).slice(0,10)!=="2026-10-27"||String(o.appointment_date).slice(0,10)!=="2026-10-27"
      ||!String(o.window_start).startsWith("11:00"))throw Error("Live order or BOL details changed");
    const hash=crypto.createHash("sha256").update(o.file_data).digest("hex");if(hash!==HASH)throw Error("Stored BOL hash mismatch");
    const proof=await db.query(`select id from email_delivery_log where account_name=$1 and status='SENT'
      and (to_addresses @> $2::jsonb or cc_addresses @> $2::jsonb or bcc_addresses @> $2::jsonb) limit 1`,[ACCOUNT,JSON.stringify(BCC)]);
    if(proof.rowCount!==1)throw Error("Dhruv recipient identity could not be verified for Alcona");
    const prior=await db.query("select status,message_id from email_delivery_log where delivery_key=$1",[KEY]);
    if(prior.rowCount){await db.query("rollback");if(prior.rows[0].status==="SENT")return console.log(JSON.stringify({alreadySent:true,messageId:prior.rows[0].message_id}));throw Error("A prior send attempt requires review");}
    if(!APPLY){await db.query("rollback");return console.log(JSON.stringify({ready:true,order:CODE,toCount:1,ccCount:0,bccCount:1,pdfSha256:hash}));}
    const claim=await db.query(`insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,
      reply_to,subject,account_name,source_type,source_ref,delivery_key,metadata)
      values('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,$4::jsonb,'support@wms365.co',$5,$6,'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
      on conflict(delivery_key) do nothing returning id`,[FROM,JSON.stringify(TO),JSON.stringify(CC),JSON.stringify(BCC),SUBJECT,ACCOUNT,CODE,KEY,
      JSON.stringify({pdfSha256:hash,filename:FILE,documentId:o.document_id,carrier:"Bison",totalKg:4208.88,
        deliveryDate:"2026-10-27",deliveryTimeEt:"11:00",addressing:"BCC_ONLY"})]);
    if(claim.rowCount!==1)throw Error("Email idempotency claim failed");logId=claim.rows[0].id;await db.query("commit");
    const text=["Hello Dhruv,","","Attached is the approved unsigned pre-shipment BOL for Alcona order ORD-001698 (PO 529673).",
      "Delivery: October 27, 2026 at 11:00 AM Eastern.","Carrier: Bison.",
      "Four pallets total 4,208.88 kg; individual pallet weights and pick locations are shown on the BOL.",
      "The order remains staged and has not been marked shipped.","","Regards,","Grey Wolf 3PL & Logistics Inc."].join("\n");
    const response=await fetch(`${(process.env.RESEND_API_URL||"https://api.resend.com").replace(/\/+$/,"")}/emails`,{
      method:"POST",headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":KEY},
      body:JSON.stringify({from:FROM,to:TO,cc:CC,bcc:BCC,reply_to:"support@wms365.co",subject:SUBJECT,text,
        attachments:[{filename:FILE,content:Buffer.from(o.file_data).toString("base64") }]}),signal:AbortSignal.timeout(30000)});
    const payload=await response.json().catch(()=>({}));if(!response.ok||!payload.id){await db.query(`update email_delivery_log
      set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,[logId,`Provider rejected BOL (${response.status})`]);throw Error(`Provider rejected email (${response.status})`);}
    await db.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1`,
      [logId,payload.id,"Resend accepted BCC-only BOL email"]);
    const final=(await db.query("select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where id=$1",[logId])).rows[0];
    if(final.status!=="SENT"||final.message_id!==payload.id||JSON.stringify(final.to_addresses)!==JSON.stringify(TO)
      ||JSON.stringify(final.cc_addresses)!=="[]"||JSON.stringify(final.bcc_addresses)!==JSON.stringify(BCC))throw Error("Final email verification failed");
    console.log(JSON.stringify({order:CODE,status:"STAGED",emailStatus:"SENT",messageId:payload.id,toCount:1,ccCount:0,bccCount:1,pdfSha256:hash}));
  }catch(e){await db.query("rollback").catch(()=>{});throw e;}finally{await db.end();}
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
