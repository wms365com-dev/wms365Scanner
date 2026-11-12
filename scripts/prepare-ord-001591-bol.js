"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const {
  APP_USER_ROLES,
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
  preparePortalOrderBillOfLading,
  reallocatePortalOrderToActualPalletLocations,
  safeDeductInventoryLineQuantity,
  updateAdminPortalOrderStatus,
  upsertInventoryLine,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001591";
const ACCOUNT = "ALCONA TRADING LTD";
const WAREHOUSE_ID = "143";
const SKU = "MS26062403";
const LOT = "MS26062403";
const CARRIER = "Polar North Freight Lines";
const DELIVERY_DATE = "2026-10-22";
const DELIVERY_TIME = "10:00";
const LB_TO_KG = 0.45359237;
const PALLETS = [
  { palletNumber: 1, from: "DI34AB", location: "DJ36AA", weightLb: 2308 },
  { palletNumber: 2, from: "DI34AC", location: "DJ30AA", weightLb: 2306 },
  { palletNumber: 3, from: "DI36AA", location: "DJ36AC", weightLb: 2318 },
  { palletNumber: 4, from: "DI36AB", location: "DJ30AC", weightLb: 2318 },
].map(p => ({ ...p, weight: Number((p.weightLb * LB_TO_KG).toFixed(2)), weightUom: "KG" }));
const TOTAL_KG = Number(PALLETS.reduce((sum, p) => sum + p.weight, 0).toFixed(2));
const FILE = `WMS365_BOL_${CODE}_2026-10-22_10AM.pdf`;
const OUT = path.resolve(__dirname, "..", "outputs", "ord-001591-bol", FILE);
const ACTOR = { id:null, email:"prathab@greywolf3pl.com", full_name:"Owner-confirmed pallet picks and BOL", role:APP_USER_ROLES.SUPER_ADMIN };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max:1 });
  const db = await pool.connect();
  let output;
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-stage-bol`]);
    const found = await db.query(`select o.*,fl.code warehouse_code from portal_orders o
      join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1 ${APPLY?'for update of o':''}`, [CODE]);
    if (found.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID || row.status !== "RELEASED"
      || row.shipped_at || row.po_number !== "529673" || row.shipping_reference !== "S2607S00390117") throw new Error("Order scope or state changed.");
    let order = await getPortalOrderById(db,row.id,ACCOUNT);
    if (order.lines.length!==1 || order.lines[0].sku!==SKU || Number(order.lines[0].quantity)!==4 || Number(order.lines[0].allocatedQuantity)!==4) throw new Error("Order line allocation mismatch.");
    const allocations = await db.query(`select a.*,i.account_name,i.quantity,i.upc,i.expiration_date,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id ${APPLY?'for update of a,i':''}`, [row.id]);
    if (allocations.rowCount!==4 || allocations.rows.some((a,i)=>a.location!==PALLETS[i].from || a.sku!==SKU || a.lot_number!==LOT
      || Number(a.allocated_quantity)!==1 || Number(a.quantity)!==1 || a.account_name!==ACCOUNT || a.tracking_level!=="PALLET")) throw new Error("Source pallet allocations changed.");
    const bins = await db.query(`select code,is_pickable,fulfillment_location_id from bin_locations where upper(code)=any($1::text[])`, [PALLETS.map(p=>p.location)]);
    if (bins.rowCount!==4 || bins.rows.some(b=>!b.is_pickable || (b.fulfillment_location_id && String(b.fulfillment_location_id)!==WAREHOUSE_ID))) throw new Error("One or more physical target bins are unavailable.");
    const targetInventory = await db.query(`select id,location,sku,lot_number,quantity from inventory_lines
      where account_name=$1 and sku=$2 and upper(location)=any($3::text[])`, [ACCOUNT,SKU,PALLETS.map(p=>p.location)]);
    if (targetInventory.rowCount) throw new Error("Target bins already contain inventory and require manual review.");
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({mode:"PREFLIGHT",order:CODE,status:row.status,carrier:CARRIER,deliveryDate:DELIVERY_DATE,deliveryTime:"10:00 AM ET",pallets:PALLETS,totalWeightKg:TOTAL_KG,locationMovesRequired:true}));
      return;
    }
    for (let i=0;i<PALLETS.length;i+=1) {
      const p=PALLETS[i],a=allocations.rows[i];
      await upsertInventoryLine(db,{accountName:ACCOUNT,location:p.location,sku:SKU,upc:a.upc||"",lotNumber:LOT,
        expirationDate:a.expiration_date||"",trackingLevel:"PALLET",quantity:1},{transactionType:"MOVE_LOCATION",
        sourceType:"PORTAL_ORDER_PALLET_LOCATION_CORRECTION",sourceId:row.id,fulfillmentLocationId:row.fulfillment_location_id,
        appUser:ACTOR,source:"web_admin",idempotencyKey:`${CODE}-${p.from}-to-${p.location}`});
    }
    order = await updateAdminPortalOrderStatus(db,row.id,"PICKING",{idempotencyKey:`${CODE}-picking`},ACTOR);
    order = await updateAdminPortalOrderStatus(db,row.id,"PICKED",{idempotencyKey:`${CODE}-picked`,pickedPalletDetails:PALLETS.map(({palletNumber,location,weight,weightUom})=>({palletNumber,location,weight,weightUom}))},ACTOR);
    for (let i=0;i<PALLETS.length;i+=1) await safeDeductInventoryLineQuantity(db,allocations.rows[i].inventory_line_id,1,{actionLabel:`record physical pallet move ${PALLETS[i].from} to ${PALLETS[i].location}`,
      transactionType:"MOVE_LOCATION",sourceType:"PORTAL_ORDER_PALLET_LOCATION_CORRECTION",sourceId:row.id,fulfillmentLocationId:row.fulfillment_location_id,
      appUser:ACTOR,source:"web_admin",idempotencyKey:`${CODE}-${PALLETS[i].from}-to-${PALLETS[i].location}`});
    order = await updateAdminPortalOrderStatus(db,row.id,"STAGED",{idempotencyKey:`${CODE}-staged`},ACTOR);
    const note=`Carrier ${CARRIER}. Delivery appointment October 22, 2026 at 10:00 AM ET. Individual pallet weights: ${PALLETS.map(p=>`${p.location} ${p.weight.toFixed(2)} kg`).join("; ")}. Heat trailer to 35 degrees Celsius and load totes 2 hours before departure. Inspect totes for damage.`;
    await db.query(`update portal_orders set order_notes=$2,shipped_carrier_name=$3,routing_total_weight=$4,
      routing_weight_uom='KG',routing_requested_delivery_date=$5::date,updated_at=now() where id=$1`,[row.id,`${row.order_notes}\n${note}`.trim(),CARRIER,TOTAL_KG,DELIVERY_DATE]);
    const token=crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
    const route=await db.query(`update order_routing_requests set status='CONFIRMED',appointment_date=$2::date,window_start=$3::time,
      window_end=null,responder_name='Owner-confirmed appointment',responder_note='Delivery at 10:00 AM ET.',responded_at=now(),updated_at=now()
      where order_id=$1 and status='PENDING' returning id`,[row.id,DELIVERY_DATE,DELIVERY_TIME]);
    if(route.rowCount!==1) throw new Error("Pending appointment could not be confirmed safely.");
    order=await getPortalOrderById(db,row.id,ACCOUNT);
    await preparePortalOrderBillOfLading(db,order,order,{shipments:[{shipmentId:order.warehouseShipments[0].id,shipmentMethod:"LTL_FREIGHT",
      carrier:CARRIER,totalPallets:4,totalWeight:TOTAL_KG,weightUom:"KG",deliveryDate:DELIVERY_DATE,bolReference:`BOL-${CODE}`}]},ACTOR);
    order=await getPortalOrderById(db,row.id,ACCOUNT);
    const bolOrder={...order,orderNotes:note,routingAppointment:{status:"CONFIRMED",appointmentDate:DELIVERY_DATE,windowStart:DELIVERY_TIME},
      pickedPalletDetails:PALLETS.map(({palletNumber,location,weight,weightUom})=>({palletNumber,location,weight,weightUom}))};
    const ready=getPortalOrderBillOfLadingReadiness(bolOrder); if(!ready.ready) throw new Error(`BOL not ready: ${ready.missingFields.join(", ")}`);
    const pdf=buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    await db.query(`insert into portal_order_documents(order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
      values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`,[row.id,FILE,pdf.content.length,pdf.content,ACTOR.full_name,order.warehouseShipments[0].id]);
    const finalAlloc=await db.query(`select a.location,a.sku,a.lot_number,a.allocated_quantity,i.quantity from portal_order_allocations a
      join inventory_lines i on i.id=a.inventory_line_id where a.order_id=$1 order by a.id`,[row.id]);
    if(order.status!=="STAGED" || order.shippedAt || finalAlloc.rows.some((a,i)=>a.location!==PALLETS[i].location || Number(a.allocated_quantity)!==1 || Number(a.quantity)<1)) throw new Error("Post-stage verification failed.");
    await db.query("commit"); fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(OUT,pdf.content);
    output={mode:"APPLIED",order:CODE,status:"STAGED",carrier:CARRIER,deliveryDate:DELIVERY_DATE,deliveryTime:"10:00 AM ET",pallets:PALLETS,totalWeightKg:TOTAL_KG,
      file:OUT,pdfSha256:crypto.createHash("sha256").update(pdf.content).digest("hex"),shipped:false};
  } catch(e){await db.query("rollback").catch(()=>{});throw e;} finally{db.release();await pool.end();}
  console.log(JSON.stringify(output));
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
