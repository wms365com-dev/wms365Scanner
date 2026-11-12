const {
    APP_USER_ROLES,
    buildPortalInboundReceiptPdfAttachment,
    updateAdminPortalInboundStatus,
    withTransaction
} = require("../server");

const INBOUND_CODE = "INB-000209";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const ACCOUNT_ID = 3918;
const WAREHOUSE_ID = 258;
const WAREHOUSE_CODE = "GW3PL-MEADOWPINE";
const SKU = "SPECTRUM VIOLET 23 BL SI 3672";
const LOT = "MPC/0769/2026";
const PALLETS = 20;
const BOXES_PER_PALLET = 12;
const TOTAL_BOXES = 240;
const KG_PER_PALLET = 360;
const RECEIVING_LOCATION = "GW3PL-MEADOWPINE-RECEIVING";
const DELIVERY_KEY = "INBOUND_RECEIVED_BCC:INB-000209:20261019";
const SUBJECT = "Inbound Received - INB-000209 - Spectrum - Meadowpine";
const APPLY = process.argv.includes("--apply");
const ACTOR = {
    id: null,
    email: "wms365-operations@wms365.co",
    full_name: "WMS365 Operations - Owner Approved Receipt",
    role: APP_USER_ROLES.SUPER_ADMIN
};

function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim().toLowerCase());
}

async function getRecipients(client) {
    const result = await client.query(
        `select email from portal_vendor_access
         where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>''
         union
         select unnest(array[portal_login_email,billing_email,ap_email,email])
         from owner_accounts where id=$2 and name=$1`,
        [ACCOUNT, ACCOUNT_ID]
    );
    const recipients = [...new Set(result.rows.map((row) => String(row.email || "").trim().toLowerCase())
        .filter((email) => validEmail(email) && email !== "support@wms365.co"))];
    if (!recipients.length) throw new Error("No active Spectrum customer recipient is available.");
    return recipients;
}

async function inspect(client, lock = false) {
    const inboundResult = await client.query(
        `select i.*,fl.code as warehouse_code
         from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         where i.inbound_code=$1 ${lock ? "for update of i" : ""}`,
        [INBOUND_CODE]
    );
    if (inboundResult.rowCount !== 1) throw new Error(`${INBOUND_CODE}: expected exactly one inbound.`);
    const inbound = inboundResult.rows[0];
    if (inbound.account_name !== ACCOUNT) throw new Error(`${INBOUND_CODE}: tenant identity changed.`);
    if (!["SUBMITTED", "RECEIVED_PENDING_PUTAWAY"].includes(inbound.status)) {
        throw new Error(`${INBOUND_CODE}: status ${inbound.status} is not the reviewed status.`);
    }
    const warehouse = await client.query(
        `select fl.id,fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_storage,cfl.customer_portal_visible
         from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.id=$2 and fl.code=$3`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || !wh.is_active || !wh.allow_inbound || !wh.allow_storage || !wh.customer_portal_visible) {
        throw new Error("Spectrum Meadowpine warehouse assignment changed.");
    }
    const lines = await client.query(
        `select l.*,c.tracking_level,c.unit_uom,c.lot_tracked,c.blocked
         from portal_inbound_lines l join item_catalog c on c.account_name=$1 and c.sku=l.sku
         where l.inbound_id=$2 order by l.line_number`,
        [ACCOUNT, inbound.id]
    );
    if (lines.rowCount !== 1 || lines.rows[0].sku !== SKU
        || Number(lines.rows[0].expected_quantity) !== TOTAL_BOXES
        || lines.rows[0].tracking_level !== "UNIT" || !lines.rows[0].lot_tracked || lines.rows[0].blocked) {
        throw new Error(`${INBOUND_CODE}: line or item-master identity changed.`);
    }
    const allocations = await client.query(
        `select * from portal_inbound_receipt_allocations where inbound_id=$1 order by allocation_number`,
        [inbound.id]
    );
    const ledger = await client.query(
        `select * from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text order by id`,
        [String(inbound.id)]
    );
    const documents = await client.query(
        `select file_name,file_type,file_size,file_data,document_category
         from portal_inbound_documents where inbound_id=$1 and document_category='SHIPMENT_PACKING_SLIP'`,
        [inbound.id]
    );
    if (documents.rowCount !== 1 || documents.rows[0].file_name !== "GW-1311-26.pdf"
        || documents.rows[0].file_type !== "application/pdf"
        || !documents.rows[0].file_data || Number(documents.rows[0].file_size) !== documents.rows[0].file_data.length) {
        throw new Error(`${INBOUND_CODE}: stored packing slip changed or is unavailable.`);
    }
    const email = await client.query(
        `select id,status,to_addresses,cc_addresses,bcc_addresses,message_id,sent_at,error_message
         from email_delivery_log where delivery_key=$1`, [DELIVERY_KEY]
    );
    const recipients = await getRecipients(client);
    return { inbound, line: lines.rows[0], allocations: allocations.rows, ledger: ledger.rows,
        packingSlip: documents.rows[0], email: email.rows[0] || null, recipients };
}

function receiptLines(line) {
    return Array.from({ length: PALLETS }, (_, index) => ({
        id: line.id,
        sku: SKU,
        receivedQuantity: BOXES_PER_PALLET,
        receivedLocation: RECEIVING_LOCATION,
        lotNumber: LOT,
        palletReference: `GW131126-P${String(index + 1).padStart(2, "0")}`,
        palletSizeType: "STANDARD_40_48_55",
        palletWeight: KG_PER_PALLET,
        palletWeightUom: "KG"
    }));
}

async function sendConfirmation(state) {
    if (state.email?.status === "SENT") return { duplicatePrevented: true, bccCount: state.email.bcc_addresses.length };
    if (!process.env.RESEND_API_KEY) throw new Error("Production Resend credentials are unavailable; email not sent.");
    const visibleTo = ["support@wms365.co"];
    const bcc = state.recipients;
    const received = state.received;
    const receiptAttachment = buildPortalInboundReceiptPdfAttachment(received);
    const text = [
        "Hello,", "",
        `Inbound ${INBOUND_CODE} has been received at Grey Wolf Meadowpine.`, "",
        `Reference: ${received.referenceNumber || "GW/1311/26"}`,
        `Item: ${SKU}`,
        `Received quantity: ${TOTAL_BOXES} boxes`,
        `Lot: ${LOT}`,
        `Pallets: ${PALLETS}`,
        `Total weight: ${PALLETS * KG_PER_PALLET} kg`,
        "Status: Received, pending putaway.", "",
        "The receiving report and source packing slip are attached.", "",
        "WMS365 Support"
    ].join("\n");
    const html = `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px">
<p>Hello,</p><p>Inbound <strong>${INBOUND_CODE}</strong> has been received at <strong>Grey Wolf Meadowpine</strong>.</p>
<table style="border-collapse:collapse;width:100%;max-width:640px">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Reference</td><td style="padding:8px;border:1px solid #d9e2e8">${received.referenceNumber || "GW/1311/26"}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Item</td><td style="padding:8px;border:1px solid #d9e2e8">${SKU}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Received</td><td style="padding:8px;border:1px solid #d9e2e8">${TOTAL_BOXES} boxes</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Lot</td><td style="padding:8px;border:1px solid #d9e2e8">${LOT}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Pallets / Weight</td><td style="padding:8px;border:1px solid #d9e2e8">${PALLETS} / ${PALLETS * KG_PER_PALLET} kg</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Status</td><td style="padding:8px;border:1px solid #d9e2e8">Received, pending putaway</td></tr>
</table><p>The receiving report and source packing slip are attached.</p><p>WMS365 Support</p></div>`;

    let logId;
    await withTransaction(async (client) => {
        const existing = await client.query("select id,status from email_delivery_log where delivery_key=$1 for update", [DELIVERY_KEY]);
        if (existing.rows[0]?.status === "SENT") {
            logId = existing.rows[0].id;
            return;
        }
        const log = await client.query(
            `insert into email_delivery_log (
                status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
                subject,account_name,source_type,source_ref,delivery_key,metadata
             ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                       'support@wms365.co',$3,$4,'INBOUND_RECEIPT',$5,$6,$7::jsonb)
             on conflict (delivery_key) do update set status='PENDING',error_message='',failed_at=null,
                 to_addresses=excluded.to_addresses,cc_addresses='[]'::jsonb,bcc_addresses=excluded.bcc_addresses,updated_at=now()
             returning id`,
            [JSON.stringify(visibleTo), JSON.stringify(bcc), SUBJECT, ACCOUNT, INBOUND_CODE, DELIVERY_KEY,
                JSON.stringify({ warehouseCode: WAREHOUSE_CODE, bccOnly: true, pallets: PALLETS, quantity: TOTAL_BOXES })]
        );
        logId = log.rows[0].id;
    });
    const alreadySent = await withTransaction(async (client) => {
        const row = await client.query("select status from email_delivery_log where id=$1", [logId]);
        return row.rows[0]?.status === "SENT";
    });
    if (alreadySent) return { duplicatePrevented: true, bccCount: bcc.length };

    try {
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": DELIVERY_KEY },
            body: JSON.stringify({
                from: "WMS365 <support@wms365.co>", to: visibleTo, cc: [], bcc,
                reply_to: "support@wms365.co", subject: SUBJECT, text, html,
                attachments: [
                    { filename: receiptAttachment.filename, content: receiptAttachment.content.toString("base64") },
                    { filename: state.packingSlip.file_name, content: state.packingSlip.file_data.toString("base64") }
                ]
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await withTransaction((client) => client.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
                    sent_at=now(),updated_at=now() where id=$1`,
            [logId, payload.id, "Resend accepted the BCC-only receipt confirmation."]
        ));
        return { duplicatePrevented: false, bccCount: bcc.length, messageIdPresent: true };
    } catch (error) {
        await withTransaction((client) => client.query(
            `update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
            [logId, String(error.message || error).slice(0, 2000)]
        )).catch(() => {});
        throw error;
    }
}

async function main() {
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const preflight = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return inspect(client);
    });
    console.log(JSON.stringify({ phase: "preflight", inbound: INBOUND_CODE, account: ACCOUNT,
        status: preflight.inbound.status, currentWarehouse: preflight.inbound.warehouse_code,
        quantity: Number(preflight.line.expected_quantity), pallets: PALLETS,
        existingAllocations: preflight.allocations.length, existingLedgerRows: preflight.ledger.length,
        bccCount: preflight.recipients.length, emailStatus: preflight.email?.status || "NONE",
        resendConfigured: Boolean(process.env.RESEND_API_KEY) }));
    if (!APPLY) return;

    const receivedState = await withTransaction(async (client) => {
        const current = await inspect(client, true);
        let received;
        if (current.inbound.status === "SUBMITTED") {
            if (current.allocations.length || current.ledger.length || current.inbound.received_at) {
                throw new Error(`${INBOUND_CODE}: existing receipt evidence blocks warehouse reassignment.`);
            }
            await client.query(
                `update portal_inbounds set fulfillment_location_id=$2,updated_at=now() where id=$1`,
                [current.inbound.id, WAREHOUSE_ID]
            );
            received = await updateAdminPortalInboundStatus(client, current.inbound.id, "RECEIVED", ACTOR, {
                receivingLocation: RECEIVING_LOCATION,
                receivingLines: receiptLines(current.line),
                note: "Owner-approved receipt at Grey Wolf Meadowpine; 20 skids, 240 boxes, lot MPC/0769/2026, 7,200 kg total. Putaway pending."
            });
        } else {
            received = current.inbound;
        }
        return { ...current, received };
    });

    const emailResult = await sendConfirmation(receivedState);
    const verified = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return inspect(client);
    });
    const receivedTotal = verified.allocations.reduce((sum, row) => sum + Number(row.quantity), 0);
    if (verified.inbound.status !== "RECEIVED_PENDING_PUTAWAY"
        || Number(verified.inbound.fulfillment_location_id) !== WAREHOUSE_ID
        || Number(verified.line.received_quantity) !== TOTAL_BOXES
        || verified.line.received_location !== RECEIVING_LOCATION
        || verified.line.lot_number !== LOT
        || verified.allocations.length !== PALLETS || receivedTotal !== TOTAL_BOXES
        || verified.allocations.some((row) => row.location !== RECEIVING_LOCATION || row.lot_number !== LOT
            || Number(row.quantity) !== BOXES_PER_PALLET || Number(row.pallet_weight) !== KG_PER_PALLET
            || row.pallet_weight_uom !== "KG")
        || verified.ledger.length !== PALLETS
        || !verified.email || verified.email.status !== "SENT"
        || verified.email.to_addresses.length !== 1 || verified.email.to_addresses[0] !== "support@wms365.co"
        || verified.email.cc_addresses.length !== 0
        || verified.email.bcc_addresses.length !== verified.recipients.length
        || !verified.email.message_id) {
        throw new Error(`${INBOUND_CODE}: post-receipt inventory or BCC email verification failed.`);
    }
    console.log(JSON.stringify({ phase: "verified", inbound: INBOUND_CODE,
        status: verified.inbound.status, warehouse: verified.inbound.warehouse_code,
        receivingLocation: verified.line.received_location, quantity: Number(verified.line.received_quantity),
        pallets: verified.allocations.length, lot: verified.line.lot_number,
        emailStatus: verified.email.status, visibleToCount: verified.email.to_addresses.length,
        ccCount: verified.email.cc_addresses.length, bccCount: verified.email.bcc_addresses.length,
        messageIdPresent: Boolean(verified.email.message_id), emailResult }));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
