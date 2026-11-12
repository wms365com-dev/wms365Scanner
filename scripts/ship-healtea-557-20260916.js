const fs = require("fs");
const { Client } = require("pg");
const {
    APP_USER_ROLES, withTransaction, getPortalOrderById, updateAdminPortalOrderStatus,
    buildPortalShipmentEmailText, buildPortalShipmentEmailHtml,
    sendStoreShipmentConfirmationsForPortalOrder, sendWarehouseBillingActivityEmail, syncWarehouseShipmentsForOrder
} = require("../server");

const apply = process.argv.includes("--apply");
const code = "ORD-000557";
const account = "HEALTEA";
const key = "HEALTEA-ORD557-SHIPPED-SHORT24-20260916";
const expected = new Map([["30627843973318",18],["30628693486072",36],["20628693486143",4],["628693486408",63],["20628693486167",45]]);
const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "k.prathab@gmail.com", full_name: "Owner-approved shipment posting" };
const files = [
    { path: "C:/Users/T470/Desktop/CamScanner 2026-09-16 18.48.pdf", name: "ORD-000557-Signed-BOL-and-Checked-Packing-Slip.pdf", type: "application/pdf", category: "SHIPMENT_BOL" },
    { path: "outputs/healtea557/page2-1.jpg", name: "ORD-000557-Checked-Packing-Slip.jpg", type: "image/jpeg", category: "SHIPMENT_PACKING_SLIP" },
    { path: "outputs/healtea557/shared-photo-3.jpg", name: "ORD-000557-Load-Photo.jpg", type: "image/jpeg", category: "SHIPMENT_LOAD_PHOTO" }
].map(file => ({ ...file, bytes: fs.readFileSync(file.path) }));
const note = "SHORT SHIPMENT: SKU 628693486408 (4-can variety pack) shipped 63 of 87 ordered cases; short 24 cases. All other items shipped in full. Total shipped: 166 cases on one pallet. Shipped September 16, 2026. Load photo source: https://photos.app.goo.gl/nNFugYQPybt4iLpb7";

async function facts(client, lock = false) {
    const rows = await client.query(`select o.*,fl.code warehouse from portal_orders o
        join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1 and o.account_name=$2${lock ? " for update of o" : ""}`, [code, account]);
    if (rows.rowCount !== 1 || rows.rows[0].warehouse !== "GW3PL-MISS") throw new Error("Order ownership/warehouse mismatch.");
    const row = rows.rows[0];
    const lines = await client.query(`select l.id,l.sku,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::integer allocated
        from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
        where l.order_id=$1 group by l.id order by l.id`, [row.id]);
    if (lines.rowCount !== expected.size) throw new Error("Unexpected order lines.");
    for (const line of lines.rows) {
        const ordered = line.sku === "628693486408" ? 87 : expected.get(line.sku);
        if (Number(line.requested_quantity) !== ordered || (row.status !== "SHIPPED" && Number(line.allocated) !== expected.get(line.sku))) throw new Error(`Quantity/allocation changed for ${line.sku}.`);
    }
    const recipients = await client.query(`select email from portal_vendor_access where account_name=$1 and is_active=true
        union select email from owner_accounts where name=$1
        union select portal_login_email from owner_accounts where name=$1
        union select billing_email from owner_accounts where name=$1
        union select ap_email from owner_accounts where name=$1`, [account]);
    const bcc = [...new Set(recipients.rows.map(r => String(r.email || "").trim().toLowerCase()).filter(Boolean))];
    if (!bcc.length || bcc.some(email => !/^[^\s@]+@(?:drinkhealtea\.com|thehealtea\.com)$/.test(email))) throw new Error(`Customer recipients require review: ${bcc.join(", ")}`);
    return { row, lines: lines.rows, bcc };
}

async function verify(client) {
    const f = await facts(client);
    if (f.row.status !== "SHIPPED" || f.row.shipped_carrier_name !== "Friends Enterprises (10971243 Canada Inc.)" || f.row.shipped_tracking_reference !== "RM 161128"
        || Number(f.row.outbound_total_pallets) !== 1 || !f.row.shipped_confirmation_note.includes("short 24 cases")) throw new Error("Shipment verification failed.");
    const date = await client.query("select confirmed_ship_date::text date from portal_orders where id=$1", [f.row.id]);
    if (date.rows[0].date !== "2026-09-16") throw new Error("Ship date verification failed.");
    const shipped = await client.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1", [f.row.id]);
    if (shipped.rowCount !== expected.size || shipped.rows.some(l => Number(l.shipped_quantity) !== expected.get(l.sku))) throw new Error("Shipped line verification failed.");
    const ledger = await client.query(`select sku,sum(quantity_delta)::integer quantity from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER' and transaction_type='SHIPPING' group by sku`, [account, String(f.row.id)]);
    if (ledger.rowCount !== expected.size || ledger.rows.some(l => -Number(l.quantity) !== expected.get(l.sku))) throw new Error("Shipping ledger verification failed.");
    const docs = await client.query("select document_category from portal_order_documents where order_id=$1", [f.row.id]);
    for (const category of files.map(file => file.category)) if (!docs.rows.some(d => d.document_category === category)) throw new Error(`Missing saved proof: ${category}.`);
    return { ...f, order: await getPortalOrderById(client, f.row.id, account) };
}

async function emailShipment(f) {
    if (!process.env.RESEND_API_KEY) throw new Error("Resend is not configured; no email sent.");
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let logId;
    try {
        let claim = await client.query(`insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
            account_name,source_type,source_ref,delivery_key,metadata)
            values('PENDING','RESEND','WMS365 <support@wms365.co>','["support@wms365.co"]'::jsonb,'[]'::jsonb,$1::jsonb,'support@wms365.co',
            'Shipment Confirmed - ORD-000557 - Short Shipment', $2,'SHIPMENT_CONFIRMATION',$3,$4,$5::jsonb)
            on conflict(delivery_key) do nothing returning id`, [JSON.stringify(f.bcc),account,code,key,JSON.stringify({ shippedCases:166,shortCases:24,shortSku:"628693486408" })]);
        if (!claim.rowCount) {
            claim = await client.query("update email_delivery_log set status='PENDING',error_message='',updated_at=now() where delivery_key=$1 and status='FAILED' returning id", [key]);
            if (!claim.rowCount) { console.log(JSON.stringify({ emailAlreadyRecorded: true })); return; }
        }
        logId = claim.rows[0].id;
        const confirmation = { confirmedShipDate:"2026-09-16",shipmentMethod:f.order.shipmentMethod,
            shippedCarrierName:f.row.shipped_carrier_name,shippedTrackingReference:f.row.shipped_tracking_reference,shippedConfirmationNote:note,
            documents:files.map(file => ({fileName:file.name,documentCategory:file.category})) };
        const text = buildPortalShipmentEmailText(f.order, confirmation);
        if (!text.includes("63") || !text.includes("87") || !text.includes("short 24 cases")) throw new Error("Email shortage validation failed.");
        const response = await fetch(`${process.env.RESEND_API_URL || "https://api.resend.com"}/emails`, {
            method:"POST",headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":key},
            body:JSON.stringify({ from:"WMS365 <support@wms365.co>",to:["support@wms365.co"],bcc:f.bcc,reply_to:"support@wms365.co",
                subject:"Shipment Confirmed - ORD-000557 - Short Shipment",text,html:buildPortalShipmentEmailHtml(f.order,confirmation),
                attachments:files.map(file => ({ filename:file.name,content:file.bytes.toString("base64") })) }),signal:AbortSignal.timeout(30000)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(`Email provider rejected shipment notice: ${data.message || response.status}`);
        await client.query("update email_delivery_log set status='SENT',message_id=$2,sent_at=now(),updated_at=now() where id=$1", [logId,data.id]);
        await client.query("update portal_orders set shipment_email_status='SENT',shipment_email_sent_at=now(),shipment_email_last_error='',updated_at=now() where id=$1 and account_name=$2", [f.row.id,account]);
        console.log(JSON.stringify({ emailSent:true,messageId:data.id,bcc:f.bcc,shortageIncluded:true }));
    } catch (error) {
        if (logId) await client.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1", [logId,error.message]).catch(() => {});
        throw error;
    } finally { await client.end(); }
}

async function main() {
    if (process.argv.includes("--sync-pallet-only")) {
        await withTransaction(async client => {
            const verified = await verify(client);
            const shipments = verified.order.warehouseShipments;
            if (!Array.isArray(shipments) || shipments.length !== 1) throw new Error("Expected exactly one warehouse shipment.");
            const corrected = { ...verified.order, warehouseShipments:shipments.map(s => ({...s,pallets:{total:1,existing:1,new:0,mixed:0}})) };
            await syncWarehouseShipmentsForOrder(client,corrected,{status:"SHIPPED"});
            const saved = await client.query("select total_pallets from warehouse_shipments where order_id=$1 and account_name=$2",[verified.row.id,account]);
            if (saved.rowCount !== 1 || Number(saved.rows[0].total_pallets) !== 1) throw new Error("Warehouse pallet verification failed.");
            console.log(JSON.stringify({warehousePalletsVerified:1,inventoryUnchanged:true,emailNotResent:true}));
        });
        return;
    }
    if (process.argv.includes("--email-only")) {
        const verified = await withTransaction(async client => {
            await client.query("set transaction read only");
            return verify(client);
        });
        await emailShipment(verified);
        console.log(JSON.stringify({verified:true,status:verified.order.status,shippedCases:166,shortCases:24,pallets:1}));
        return;
    }
    if (apply && process.env.CONFIRM_HEALTEA_557 !== "APPROVED_166_CASES_SHORT24_SEPT16") throw new Error("Explicit shipment confirmation required.");
    const result = await withTransaction(async client => {
        if (!apply) await client.query("set transaction read only");
        const f = await facts(client,apply);
        console.log(JSON.stringify({ order:code,status:f.row.status,shipDate:"2026-09-16",cases:166,pallets:1,shortSku:"628693486408",shortCases:24,bcc:f.bcc }));
        if (!apply) return null;
        if (f.row.status === "SHIPPED") return { ...await verify(client), duplicate:true };
        if (!["PICKED","STAGED"].includes(f.row.status)) throw new Error("Order must be picked or staged.");
        if (!process.env.RESEND_API_KEY) throw new Error("Email provider is not configured.");
        if (f.row.status === "PICKED") await updateAdminPortalOrderStatus(client,f.row.id,"STAGED",{idempotencyKey:`${key}-staged`},actor);
        const order = await updateAdminPortalOrderStatus(client,f.row.id,"SHIPPED", {
            idempotencyKey:`${key}-shipped`,confirmedShipDate:"2026-09-16",shipmentMethod:f.row.shipment_method,
            carrierName:"Friends Enterprises (10971243 Canada Inc.)",trackingReference:"RM 161128",packingSlipQuantityConfirmed:true,
            note,moveShortageToInvestigation:false,outboundPallets:{totalPalletsOut:1,existingPalletsOut:1,newPalletsUsed:0,mixedPalletsBuilt:0,palletNote:"One pallet per signed BOL correction."},
            shippedLines:f.lines.map(l => ({orderLineId:l.id,sku:l.sku,shippedQuantity:expected.get(l.sku)})),
            documents:files.map(file => ({fileName:file.name,fileType:file.type,documentCategory:file.category,dataUrl:`data:${file.type};base64,${file.bytes.toString("base64")}`}))
        },actor);
        // Reserve email handling for the BCC-only confirmation; avoid a second automatic notice.
        await client.query("update portal_orders set shipment_email_status='SKIPPED',shipment_email_last_error='Owner-approved BCC-only shipment notice handled by dedicated delivery record' where id=$1", [f.row.id]);
        return { ...await verify(client), duplicate:false, billingEvents:order.billingEventsCreated || [] };
    });
    if (!result) return;
    await emailShipment(result);
    if (!result.duplicate) {
        await sendStoreShipmentConfirmationsForPortalOrder(result.order,{ confirmedShipDate:"2026-09-16",carrierName:result.row.shipped_carrier_name,trackingReference:result.row.shipped_tracking_reference });
        await sendWarehouseBillingActivityEmail({activityType:"ORDER_SHIPPED",accountName:account,sourceRef:code,document:result.order,billingEvents:result.billingEvents});
    }
    console.log(JSON.stringify({ verified:true,status:result.order.status,shippedCases:166,shortCases:24,pallets:1 }));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode=1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0),50));
