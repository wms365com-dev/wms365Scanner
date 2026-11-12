"use strict";
const crypto = require("node:crypto");
const { Client } = require("pg");
const { buildPortalOrderBillOfLadingPdfAttachment, getPortalOrderBillOfLadingReadiness, getPortalOrderById } = require("../server");
const CODE = "ORD-001698", ACCOUNT = "ALCONA TRADING LTD", FILE = "WMS365_BOL_ORD-001698_2026-10-27_11AM.pdf";
const PALLETS = [["DJ24AC",1052.79],["DJ22AC",1052.33],["DJ20AC",1052.33],["DJ18AC",1051.43]]
  .map(([location,weight],i)=>({palletNumber:i+1,location,weight,weightUom:"KG"}));
async function main(){
  const db=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});await db.connect();
  try{await db.query("begin");await db.query("select pg_advisory_xact_lock(hashtext($1))",[`${CODE}-bol-window`]);
    const found=await db.query(`select o.id,o.status,o.shipped_at,o.po_number,o.shipped_carrier_name,o.routing_requested_delivery_date::text,
      o.routing_total_weight,o.routing_weight_uom from portal_orders o where o.order_code=$1 and o.account_name=$2 for update`,[CODE,ACCOUNT]);
    if(found.rowCount!==1)throw Error("Order identity mismatch");const row=found.rows[0];
    if(row.status!=="STAGED"||row.shipped_at||row.po_number!=="529673"||row.shipped_carrier_name!=="Bison"
      ||String(row.routing_requested_delivery_date).slice(0,10)!=="2026-10-27"||Number(row.routing_total_weight)!==4208.88||row.routing_weight_uom!=="KG")
      throw Error("Saved shipment fields changed");
    const route=await db.query(`select status,appointment_date::text,window_start::text from order_routing_requests where order_id=$1 order by id desc`,[row.id]);
    if(route.rowCount!==1||route.rows[0].status!=="PENDING"||String(route.rows[0].appointment_date).slice(0,10)!=="2026-10-27"
      ||!String(route.rows[0].window_start).startsWith("11:00"))throw Error("Requested appointment fields changed");
    const order=await getPortalOrderById(db,row.id,ACCOUNT);
    const note=`Carrier Bison. Delivery requested October 27, 2026 at 11:00 AM ET. Physical pallets: ${PALLETS.map(p=>`${p.location} ${p.weight.toFixed(2)} kg`).join("; ")}. Total 4208.88 kg. PRE-SHIPMENT / UNSIGNED.`;
    const bolOrder={...order,orderNotes:note,pickedPalletDetails:PALLETS,
      routingAppointment:{status:"CONFIRMED",appointmentDate:"2026-10-27",windowStart:"11:00"}};
    const readiness=getPortalOrderBillOfLadingReadiness(bolOrder);if(!readiness.ready)throw Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const pdf=buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    const updated=await db.query(`update portal_order_documents set file_data=$3,file_size=$4,uploaded_by=$5
      where order_id=$1 and file_name=$2 returning id`,[row.id,FILE,pdf.content,pdf.content.length,"Owner-reviewed 11 AM BOL"]);
    if(updated.rowCount!==1)throw Error("Saved BOL identity mismatch");await db.query("commit");
    console.log(JSON.stringify({order:CODE,fileName:FILE,documentBytes:pdf.content.length,
      pdfSha256:crypto.createHash("sha256").update(pdf.content).digest("hex"),window:"11:00 AM ET",routingStatus:"PENDING",emailsSent:0}));
  }catch(e){await db.query("rollback").catch(()=>{});throw e;}finally{await db.end();}
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
