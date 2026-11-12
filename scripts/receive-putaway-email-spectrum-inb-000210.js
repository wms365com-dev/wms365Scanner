"use strict";

const { Client } = require("pg");
const { APP_USER_ROLES, buildPortalInboundReceiptPdfAttachment, updateAdminPortalInboundStatus } = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "INB-000210";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const ACCOUNT_ID = "3918";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const REFERENCE = "GW1314/26";
const RECEIPT_DATE = "2026-11-04";
const DESTINATION = "GW3PL-MISS-SPECTRUM-BULK";
const SKU = "SPECTRUM RED 2 DCI";
const LOT = "2603103";
const QUANTITY = 54;
const PALLETS = 3;
const BAGS_PER_PALLET = 18;
const KG_PER_BAG = 20;
const PALLET_WEIGHT_KG = 360;
const DELIVERY_KEY = "INBOUND_RECEIVED_BCC:INB-000210:20261104";
const SUBJECT = "Inbound Received - INB-000210 - Spectrum - Mississauga";
const ACTOR = { id: null, email: "operations@wms365.co", full_name: "WMS365 Owner-Approved Inbound", role: APP_USER_ROLES.SUPER_ADMIN };

function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }

async function recipients(db) {
    const result = await db.query(`select email from portal_vendor_access
        where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>''
        union select unnest(array[portal_login_email,billing_email,ap_email,email])
        from owner_accounts where id=$2 and name=$1`, [ACCOUNT, ACCOUNT_ID]);
    const values = [...new Set(result.rows.map((row) => String(row.email || "").trim().toLowerCase())
        .filter((email) => validEmail(email) && email !== "support@wms365.co"))];
    if (!values.length) throw new Error("No approved active Spectrum receipt recipient is available.");
    return values;
}

async function main() {
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    let committed = false;
    let receiptAttachment;
    let packingSlip;
    let recipientList;
    try {
        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-RECEIVE-PUTAWAY`]);
        const account = await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
        if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) throw new Error("Spectrum account identity mismatch.");
        const inboundResult = await db.query(`select i.*,fl.code warehouse_code from portal_inbounds i
            join fulfillment_locations fl on fl.id=i.fulfillment_location_id
            where i.inbound_code=$1 for update of i`, [CODE]);
        if (inboundResult.rowCount !== 1) throw new Error("INB-000210 was not found uniquely.");
        const inbound = inboundResult.rows[0];
        if (inbound.account_name !== ACCOUNT || inbound.reference_number !== REFERENCE
            || Number(inbound.fulfillment_location_id) !== WAREHOUSE_ID || inbound.warehouse_code !== WAREHOUSE_CODE) {
            throw new Error("Inbound ownership, reference, or warehouse changed.");
        }
        const lineResult = await db.query(`select l.*,c.description,c.upc,c.tracking_level,c.unit_uom,
            c.lot_tracked,c.expiration_tracked,c.blocked,c.item_type
            from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
            where l.inbound_id=$1 for update of l`, [inbound.id, ACCOUNT]);
        if (lineResult.rowCount !== 1) throw new Error("Inbound line count changed.");
        const line = lineResult.rows[0];
        if (line.sku !== SKU || Number(line.expected_quantity) !== QUANTITY || line.received_quantity != null
            || line.tracking_level !== "UNIT" || line.unit_uom !== "BAG" || !line.lot_tracked
            || line.expiration_tracked || line.blocked || line.item_type !== "INVENTORY") {
            throw new Error("Inbound line or item controls changed.");
        }
        const doc = await db.query(`select file_name,file_type,file_size,file_data from portal_inbound_documents
            where inbound_id=$1 and document_category='SHIPMENT_PACKING_SLIP'`, [inbound.id]);
        if (doc.rowCount !== 1 || doc.rows[0].file_name !== "GW-1314-26.pdf" || !doc.rows[0].file_data
            || Number(doc.rows[0].file_size) !== doc.rows[0].file_data.length) throw new Error("Verified packing slip is unavailable or changed.");
        packingSlip = doc.rows[0];
        const bin = await db.query(`select account_name,fulfillment_location_id,location_type,is_pickable
            from bin_locations where code=$1 for update`, [DESTINATION]);
        if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT
            || Number(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID
            || bin.rows[0].location_type !== "STORAGE" || !bin.rows[0].is_pickable) throw new Error("Spectrum pickable destination changed.");
        const prior = await Promise.all([
            db.query("select count(*)::integer count from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1", [String(inbound.id)]),
            db.query("select count(*)::integer count from portal_inbound_pallet_labels where inbound_id=$1", [inbound.id]),
            db.query("select count(*)::integer count from portal_inbound_receipt_allocations where inbound_id=$1", [inbound.id]),
            db.query(`select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                where account_name=$1 and location=$2 and sku=$3 and lot_number=$4`, [ACCOUNT, DESTINATION, SKU, LOT])
        ]);
        if (inbound.status === "PUTAWAY_COMPLETE" && inbound.received_at) {
            await db.query("rollback");
            console.log(JSON.stringify({ outcome: "already_received", inbound: CODE }));
            return;
        }
        if (inbound.status !== "SUBMITTED" || inbound.received_at
            || prior.slice(0, 3).some((entry) => Number(entry.rows[0].count) !== 0)) throw new Error("Inbound is not in a clean receivable state.");
        recipientList = await recipients(db);

        for (let index = 1; index <= PALLETS; index += 1) {
            const palletCode = `GW131426-P${String(index).padStart(2, "0")}`;
            const label = await db.query(`insert into portal_inbound_pallet_labels
                (inbound_id,line_id,pallet_code,account_name,sku,upc,description,cases_on_pallet,expected_quantity,
                 pallet_type,pallet_status,is_mixed,billable,pallet_size_type,pallet_length_inches,pallet_width_inches,
                 pallet_height_inches,pallet_size_note,label_date,created_by,notes)
                values($1,$2,$3,$4,$5,$6,$7,$8,$8,'SINGLE_SKU','PLANNED',false,true,'STANDARD_40_48_55',40,48,55,'',$9,$10,$11)
                returning id`, [inbound.id,line.id,palletCode,ACCOUNT,SKU,line.upc || "",line.description,BAGS_PER_PALLET,
                RECEIPT_DATE,ACTOR.full_name,`${BAGS_PER_PALLET} bags x ${KG_PER_BAG} kg; ${PALLET_WEIGHT_KG} kg; lot ${LOT}.`]);
            await db.query(`insert into portal_inbound_pallet_label_contents
                (pallet_label_id,inbound_id,line_id,sku,quantity,lot_number,expiration_date)
                values($1,$2,$3,$4,$5,$6,null)`, [label.rows[0].id,inbound.id,line.id,SKU,BAGS_PER_PALLET,LOT]);
        }
        let received = await updateAdminPortalInboundStatus(db, inbound.id, "ARRIVED", ACTOR,
            { note: `Received ${RECEIPT_DATE} from packing slip ${REFERENCE}.` });
        received = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
            receivingLocation: DESTINATION,
            receivingLines: Array.from({ length: PALLETS }, (_, index) => ({
                id: line.id, sku: SKU, receivedQuantity: BAGS_PER_PALLET, receivedLocation: DESTINATION,
                lotNumber: LOT, palletReference: `GW131426-P${String(index + 1).padStart(2, "0")}`,
                palletSizeType: "STANDARD_40_48_55", palletWeight: PALLET_WEIGHT_KG, palletWeightUom: "KG"
            })),
            note: "Three skids / 54 bags received in full per verified packing slip and owner instruction."
        });
        received = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR,
            { note: `Three skids put away to ${DESTINATION}; inventory is pickable.` });
        await db.query(`update portal_inbounds set arrived_at=($2::date + time '12:00') at time zone 'America/Toronto',
            received_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now() where id=$1`, [inbound.id, RECEIPT_DATE]);
        await db.query(`update portal_inbound_pallet_labels set label_date=$2::date,
            confirmed_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now() where inbound_id=$1`, [inbound.id, RECEIPT_DATE]);
        await db.query(`update billing_events set service_date=$3::date,updated_at=now()
            where account_name=$1 and source_type='INBOUND_RECEIPT' and source_ref=$2 and status<>'VOID'`, [ACCOUNT, CODE, RECEIPT_DATE]);

        const [head,savedLine,labels,allocations,ledger,stock] = await Promise.all([
            db.query(`select status,to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date from portal_inbounds where id=$1`, [inbound.id]),
            db.query("select received_quantity,received_location,lot_number,pallet_count from portal_inbound_lines where id=$1", [line.id]),
            db.query(`select count(*)::integer count,sum(actual_quantity)::integer quantity,
                count(*) filter(where pallet_status='RECEIVED')::integer received from portal_inbound_pallet_labels where inbound_id=$1`, [inbound.id]),
            db.query(`select count(*)::integer count,sum(quantity)::integer quantity,count(distinct pallet_reference)::integer pallets
                from portal_inbound_receipt_allocations where inbound_id=$1`, [inbound.id]),
            db.query(`select count(*)::integer count,sum(quantity_delta)::integer quantity from inventory_transactions
                where source_type='PORTAL_INBOUND' and source_id=$1 and transaction_type='RECEIVING'`, [String(inbound.id)]),
            db.query(`select coalesce(sum(i.quantity),0)::integer quantity,bool_and(b.is_pickable) pickable
                from inventory_lines i join bin_locations b on b.code=i.location
                where i.account_name=$1 and i.location=$2 and i.sku=$3 and i.lot_number=$4`, [ACCOUNT,DESTINATION,SKU,LOT])
        ]);
        if (head.rows[0].status !== "PUTAWAY_COMPLETE" || head.rows[0].receipt_date !== RECEIPT_DATE
            || Number(savedLine.rows[0].received_quantity) !== QUANTITY || savedLine.rows[0].received_location !== DESTINATION
            || savedLine.rows[0].lot_number !== LOT || Number(labels.rows[0].count) !== PALLETS
            || Number(labels.rows[0].received) !== PALLETS || Number(labels.rows[0].quantity) !== QUANTITY
            || Number(allocations.rows[0].count) !== PALLETS || Number(allocations.rows[0].quantity) !== QUANTITY
            || Number(allocations.rows[0].pallets) !== PALLETS || Number(ledger.rows[0].count) !== PALLETS
            || Number(ledger.rows[0].quantity) !== QUANTITY
            || Number(stock.rows[0].quantity) - Number(prior[3].rows[0].quantity) !== QUANTITY || stock.rows[0].pickable !== true) {
            throw new Error("Post-receipt inventory verification failed.");
        }
        receiptAttachment = buildPortalInboundReceiptPdfAttachment(received);
        if (!APPLY) {
            await db.query("rollback");
            console.log(JSON.stringify({ mode: "PREFLIGHT", inbound: CODE, receiptDate: RECEIPT_DATE,
                quantity: QUANTITY, pallets: PALLETS, lot: LOT, destination: DESTINATION, pickable: true,
                recipientCount: recipientList.length, emailConfigured: Boolean(process.env.RESEND_API_KEY) }));
            return;
        }
        await db.query("commit");
        committed = true;

        if (!process.env.RESEND_API_KEY) throw new Error("Receipt posted, but production email credentials are unavailable.");
        const claim = await db.query(`insert into email_delivery_log
            (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
             account_name,source_type,source_ref,delivery_key,metadata)
            values('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
             'support@wms365.co',$3,$4,'INBOUND_RECEIPT',$5,$6,$7::jsonb)
            on conflict(delivery_key) do nothing returning id`, [JSON.stringify(["support@wms365.co"]),
            JSON.stringify(recipientList),SUBJECT,ACCOUNT,CODE,DELIVERY_KEY,
            JSON.stringify({ warehouseCode: WAREHOUSE_CODE,bccOnly: true,pallets: PALLETS,quantity: QUANTITY,lot: LOT })]);
        if (claim.rowCount !== 1) {
            const priorEmail = await db.query("select status,message_id from email_delivery_log where delivery_key=$1", [DELIVERY_KEY]);
            if (priorEmail.rows[0]?.status === "SENT") {
                console.log(JSON.stringify({ mode: "ALREADY_COMPLETED", inbound: CODE, emailStatus: "SENT" }));
                return;
            }
            throw new Error("A prior receipt confirmation attempt requires review.");
        }
        const logId = claim.rows[0].id;
        const text = ["Hello,", "", `Inbound ${CODE} has been received and put away at Grey Wolf Mississauga.`, "",
            `Reference: ${REFERENCE}`, `Item: ${SKU}`, `Received quantity: ${QUANTITY} bags`, `Lot: ${LOT}`,
            `Pallets: ${PALLETS}`, `Total weight: ${QUANTITY * KG_PER_BAG} kg`, `Receipt date: ${RECEIPT_DATE}`,
            "Status: Putaway complete and available for picking.", "", "The receiving report and source packing slip are attached.", "", "WMS365 Support"].join("\n");
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": DELIVERY_KEY },
            body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: ["support@wms365.co"], cc: [], bcc: recipientList,
                reply_to: "support@wms365.co", subject: SUBJECT, text, attachments: [
                    { filename: receiptAttachment.filename, content: receiptAttachment.content.toString("base64") },
                    { filename: packingSlip.file_name, content: packingSlip.file_data.toString("base64") }
                ] }), signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) {
            await db.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",
                [logId, `Provider rejected receipt confirmation (${response.status})`]);
            throw new Error(`Receipt posted, but email provider rejected confirmation (${response.status}).`);
        }
        await db.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
            sent_at=now(),updated_at=now() where id=$1`, [logId,payload.id,"Resend accepted BCC-only inbound receipt confirmation"]);
        const email = (await db.query("select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where id=$1", [logId])).rows[0];
        if (email.status !== "SENT" || !email.message_id || email.to_addresses.length !== 1
            || email.cc_addresses.length !== 0 || email.bcc_addresses.length !== recipientList.length) throw new Error("Final receipt email verification failed.");
        console.log(JSON.stringify({ mode: "APPLIED", inbound: CODE, status: "PUTAWAY_COMPLETE",
            receiptDate: RECEIPT_DATE, quantity: QUANTITY, pallets: PALLETS, lot: LOT,
            destination: DESTINATION, pickable: true, emailStatus: "SENT", recipientCount: recipientList.length,
            messageIdPresent: true }));
    } catch (error) {
        if (!committed) await db.query("rollback").catch(() => {});
        throw error;
    } finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
