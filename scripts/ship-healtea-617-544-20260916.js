const fs = require("fs");
const { Client } = require("pg");
const { APP_USER_ROLES, withTransaction, getPortalOrderById, updateAdminPortalOrderStatus,
    syncWarehouseShipmentsForOrder, buildPortalShipmentEmailText, buildPortalShipmentEmailHtml,
    sendStoreShipmentConfirmationsForPortalOrder, sendWarehouseBillingActivityEmail } = require("../server");

const account = "HEALTEA";
const key = "HEALTEA-617-544-SHIPPED-20260916";
const apply = process.argv.includes("--apply");
const actor = { role:APP_USER_ROLES.SUPER_ADMIN,email:"k.prathab@gmail.com",full_name:"Owner-approved combined shipment" };
const specs = [
    {code:"ORD-000544",pallets:2,ordered:{"20628693486143":138,"20628693486136":10,"30627843973301":18,"30627843973318":36},
        shipped:{"20628693486143":138,"20628693486136":10,"30627843973301":18,"30627843973318":36},
        note:"Shipped complete September 16, 2026 with ORD-000617 under CimTran BOL P063706. Owner confirmed 2 pallets for this order, 1 pallet for ORD-000617, 3 total. Printed BOL date September 1 differs from September 16 signatures; actual ship date follows signed pickup. BOL weight 2600 kg is combined, not allocated to individual orders."},
    {code:"ORD-000617",pallets:1,ordered:{"20628693486167":108,"30628693486072":36},shipped:{"20628693486167":103,"30628693486072":24},
        note:"SHORT SHIPMENT: SKU 20628693486167 shipped 103 of 108 cases, short 5 cases; SKU 30628693486072 shipped 24 of 36 cases, short 12 cases. Total shipped 127 cases; short 17 cases. Shipped September 16, 2026 with ORD-000544 under CimTran BOL P063706. Owner confirmed 1 pallet for this order, 2 pallets for ORD-000544, 3 total. Printed BOL date September 1 differs from September 16 signed pickup. Combined BOL weight 2600 kg is not allocated to individual orders."}
];
const files = [
    {name:"ORD-000544-000617-Signed-CimTran-BOL-P063706.jpg",path:"outputs/healtea617544/page1-1.jpg",category:"SHIPMENT_BOL"},
    {name:"ORD-000617-Checked-Packing-Slip.jpg",path:"outputs/healtea617544/page2-1.jpg",category:"SHIPMENT_PACKING_SLIP"},
    {name:"ORD-000617-Checked-Pick-Ticket.jpg",path:"outputs/healtea617544/page3-1.jpg",category:"GENERAL"}
].map(f=>({...f,bytes:fs.readFileSync(f.path)}));
for(const f of files) if(f.bytes.length>4*1024*1024) throw new Error(`${f.name} exceeds WMS upload limit.`);

async function facts(client,spec,lock=false) {
    const result=await client.query(`select o.*,o.confirmed_ship_date::text ship_date,fl.code warehouse from portal_orders o
        join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.account_name=$1 and o.order_code=$2${lock?" for update of o":""}`,[account,spec.code]);
    if(result.rowCount!==1) throw new Error(`${spec.code}: unique company-owned order required.`);
    const row=result.rows[0];
    if(row.warehouse!=="GW3PL-MISS" || row.shipment_method!=="CUSTOMER_PICKUP" || !["STAGED","SHIPPED"].includes(row.status)) throw new Error(`${spec.code}: warehouse, method or status changed.`);
    const lines=await client.query(`select l.id,l.sku,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::integer allocated
        from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id where l.order_id=$1 group by l.id order by l.id`,[row.id]);
    if(lines.rowCount!==Object.keys(spec.ordered).length || lines.rows.some(l=>spec.ordered[l.sku]!==Number(l.requested_quantity)
        || (row.status!=="SHIPPED" && spec.shipped[l.sku]!==Number(l.allocated)))) throw new Error(`${spec.code}: order quantity/allocation mismatch.`);
    return {row,lines:lines.rows,spec};
}

async function verify(client,spec) {
    const f=await facts(client,spec);
    if(f.row.status!=="SHIPPED" || f.row.ship_date!=="2026-09-16" || f.row.shipped_carrier_name!=="CimTran"
        || f.row.shipped_tracking_reference!=="P063706" || Number(f.row.outbound_total_pallets)!==spec.pallets) throw new Error(`${spec.code}: shipment fields failed verification.`);
    const lines=await client.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1",[f.row.id]);
    const ledger=await client.query(`select sku,sum(quantity_delta)::integer quantity from inventory_transactions where account_name=$1
        and source_type='PORTAL_ORDER' and source_id=$2 and transaction_type='SHIPPING' group by sku`,[account,String(f.row.id)]);
    for(const rows of [lines.rows,ledger.rows]) if(rows.length!==Object.keys(spec.shipped).length || rows.some(l=>spec.shipped[l.sku]!==Number(l.shipped_quantity??-l.quantity))) throw new Error(`${spec.code}: shipped quantities/ledger failed verification.`);
    const shipments=await client.query("select total_pallets,status from warehouse_shipments where account_name=$1 and order_id=$2",[account,f.row.id]);
    if(shipments.rowCount!==1 || shipments.rows[0].status!=="SHIPPED" || Number(shipments.rows[0].total_pallets)!==spec.pallets) throw new Error(`${spec.code}: warehouse shipment pallet mismatch.`);
    const docs=await client.query("select file_name from portal_order_documents where order_id=$1",[f.row.id]);
    if(!docs.rows.some(d=>d.file_name===files[0].name)) throw new Error(`${spec.code}: signed BOL not attached.`);
    return {...f,order:await getPortalOrderById(client,f.row.id,account)};
}

async function recipients(client) {
    const result=await client.query(`select email from portal_vendor_access where account_name=$1 and is_active=true
        union select email from owner_accounts where name=$1 union select portal_login_email from owner_accounts where name=$1
        union select billing_email from owner_accounts where name=$1 union select ap_email from owner_accounts where name=$1`,[account]);
    const bcc=[...new Set(result.rows.map(r=>String(r.email||"").trim().toLowerCase()).filter(Boolean))];
    if(!bcc.length || bcc.some(e=>!/^[^\s@]+@(?:thehealtea\.com|drinkhealtea\.com)$/.test(e))) throw new Error(`Review company recipients: ${bcc.join(", ")}`);
    return bcc;
}

async function sendEmail(results,bcc) {
    if(!process.env.RESEND_API_KEY) throw new Error("Resend unavailable; shipment email not sent.");
    const confirmations=results.map(f=>({confirmedShipDate:"2026-09-16",shipmentMethod:f.row.shipment_method,shippedCarrierName:"CimTran",
        shippedTrackingReference:"P063706",shippedConfirmationNote:f.spec.note,documents:files.map(file=>({fileName:file.name,documentCategory:file.category}))}));
    const text=results.map((f,i)=>buildPortalShipmentEmailText(f.order,confirmations[i])).join("\n\n--------------------\n\n");
    if(!text.includes("short 17 cases") || !text.includes("103 of 108") || !text.includes("24 of 36")) throw new Error("Combined email shortage check failed.");
    const client=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL,ssl:false});
    await client.connect(); let logId;
    try {
        let claim=await client.query(`insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
            subject,account_name,source_type,source_ref,delivery_key,metadata) values('PENDING','RESEND','WMS365 <support@wms365.co>',
            '["support@wms365.co"]'::jsonb,'[]'::jsonb,$1::jsonb,'support@wms365.co','Shipment Confirmed - ORD-000617 and ORD-000544',
            $2,'SHIPMENT_CONFIRMATION','ORD-000617 / ORD-000544',$3,'{"cases":329,"pallets":3,"shortCases":17}'::jsonb)
            on conflict(delivery_key) do nothing returning id`,[JSON.stringify(bcc),account,key]);
        if(!claim.rowCount) claim=await client.query("update email_delivery_log set status='PENDING',error_message='',updated_at=now() where delivery_key=$1 and status='FAILED' returning id",[key]);
        if(!claim.rowCount) {console.log(JSON.stringify({emailAlreadyRecorded:true}));return;}
        logId=claim.rows[0].id;
        const response=await fetch(`${process.env.RESEND_API_URL||"https://api.resend.com"}/emails`,{method:"POST",
            headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":key},
            body:JSON.stringify({from:"WMS365 <support@wms365.co>",to:["support@wms365.co"],bcc,reply_to:"support@wms365.co",
                subject:"Shipment Confirmed - ORD-000617 and ORD-000544",text,
                html:results.map((f,i)=>buildPortalShipmentEmailHtml(f.order,confirmations[i])).join("<hr>"),
                attachments:files.map(file=>({filename:file.name,content:file.bytes.toString("base64")}))}),signal:AbortSignal.timeout(30000)});
        const data=await response.json();if(!response.ok) throw new Error(`Email rejected: ${data.message||response.status}`);
        await client.query("update email_delivery_log set status='SENT',message_id=$2,sent_at=now(),updated_at=now() where id=$1",[logId,data.id]);
        await client.query("update portal_orders set shipment_email_status='SENT',shipment_email_sent_at=now(),shipment_email_last_error='',updated_at=now() where account_name=$1 and order_code=any($2::text[])",[account,specs.map(s=>s.code)]);
        console.log(JSON.stringify({emailSent:true,bcc,messageId:data.id,shortageIncluded:true}));
    } catch(error) {if(logId) await client.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",[logId,error.message]).catch(()=>{});throw error;}
    finally {await client.end();}
}

async function main() {
    const emailOnly=process.argv.includes("--email-only");
    if(apply && process.env.CONFIRM_HEALTEA_617_544!=="APPROVED_127_202_CASES_1_2_PALLETS") throw new Error("Explicit posting confirmation required.");
    const result=await withTransaction(async client=>{
        if(!apply) await client.query("set transaction read only");
        const bcc=await recipients(client);const checked=[];
        for(const spec of specs) checked.push(await facts(client,spec,apply));
        if(emailOnly) {const results=[];for(const spec of specs) results.push(await verify(client,spec));return {results,bcc};}
        console.log(JSON.stringify({preflight:checked.map(f=>({code:f.spec.code,status:f.row.status,cases:Object.values(f.spec.shipped).reduce((s,n)=>s+n,0),pallets:f.spec.pallets})),bcc}));
        if(!apply) return null;
        if(!process.env.RESEND_API_KEY) throw new Error("Email provider unavailable.");
        const results=[];
        for(const f of checked) {
            if(f.row.status==="SHIPPED") {results.push({...await verify(client,f.spec),duplicate:true});continue;}
            const attached=f.spec.code==="ORD-000617"?files:[files[0]];
            const order=await updateAdminPortalOrderStatus(client,f.row.id,"SHIPPED",{idempotencyKey:`${key}-${f.row.id}`,confirmedShipDate:"2026-09-16",
                shipmentMethod:f.row.shipment_method,carrierName:"CimTran",trackingReference:"P063706",packingSlipQuantityConfirmed:true,
                note:f.spec.note,moveShortageToInvestigation:false,outboundPallets:{totalPalletsOut:f.spec.pallets,existingPalletsOut:f.spec.pallets,newPalletsUsed:0,mixedPalletsBuilt:0,
                    palletNote:"Combined 3-pallet shipment: ORD-000617 1 pallet; ORD-000544 2 pallets, owner confirmed."},
                shippedLines:f.lines.map(l=>({orderLineId:l.id,sku:l.sku,shippedQuantity:f.spec.shipped[l.sku]})),
                documents:attached.map(file=>({fileName:file.name,fileType:"image/jpeg",documentCategory:file.category,dataUrl:`data:image/jpeg;base64,${file.bytes.toString("base64")}`}))},actor);
            if(order.warehouseShipments.length!==1) throw new Error("Expected one warehouse shipment per order.");
            await syncWarehouseShipmentsForOrder(client,{...order,warehouseShipments:order.warehouseShipments.map(s=>({...s,pallets:{total:f.spec.pallets,existing:f.spec.pallets,new:0,mixed:0}}))},{status:"SHIPPED"});
            await client.query("update portal_orders set shipment_email_status='SKIPPED',shipment_email_last_error='Combined BCC-only shipment notice handled by dedicated delivery record' where id=$1",[f.row.id]);
            results.push({...await verify(client,f.spec),duplicate:false,billingEvents:order.billingEventsCreated||[]});
        }
        return {results,bcc};
    });
    if(!result) return;
    await sendEmail(result.results,result.bcc);
    if(!emailOnly) for(const f of result.results.filter(r=>!r.duplicate)) {
        await sendStoreShipmentConfirmationsForPortalOrder(f.order,{confirmedShipDate:"2026-09-16",carrierName:"CimTran",trackingReference:"P063706"});
        await sendWarehouseBillingActivityEmail({activityType:"ORDER_SHIPPED",accountName:account,sourceRef:f.spec.code,document:f.order,billingEvents:f.billingEvents});
    }
    console.log(JSON.stringify({verified:result.results.map(f=>({order:f.spec.code,status:f.order.status,cases:Object.values(f.spec.shipped).reduce((s,n)=>s+n,0),pallets:f.spec.pallets}))}));
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;}).finally(()=>setTimeout(()=>process.exit(process.exitCode||0),50));
