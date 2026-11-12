const crypto = require("node:crypto");
const { Client } = require("pg");

const orderCode = "ORD-001338";
const account = "ALCONA TRADING LTD";
const key = "owner-ord-001338-bol-dhruv-20260929-v2";
const from = "WMS365 <support@wms365.co>";
const to = ["support@wms365.co"];
const bcc = ["d.jain@emotrans-canada.com"];
const filename = "WMS365_BOL_ORD-001338_2026-09-29_REV2.pdf";
const subject = "Corrected BOL - Alcona ORD-001338 / PO 529672";
const locations = ["DI14AA", "DI12AA", "DI16AA", "DI18AA"];
const weights = [2311, 2311, 2311, 2312];
const apply = process.argv.includes("--apply");
const revision = process.argv.includes("--revision-2");

async function main(pdfBase64, expectedHash) {
    if (!revision) throw new Error("Explicit --revision-2 flag required for corrected BOL resend");
    if (!process.env.RESEND_API_KEY) throw new Error("Resend email provider is unavailable");
    const pdf = Buffer.from(String(pdfBase64 || ""), "base64");
    const hash = crypto.createHash("sha256").update(pdf).digest("hex");
    if (pdf.subarray(0, 4).toString() !== "%PDF" || hash !== expectedHash || pdf.length < 1000) {
        throw new Error("The supplied PDF does not match the reviewed BOL");
    }
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let logId;
    let documentId;
    try {
        await client.query("begin");
        try {
            const order = await client.query(
                `select id,order_code,account_name,status,fulfillment_location_id,
                        shipped_at,shipped_carrier_name,requested_ship_date::text,
                        routing_requested_delivery_date::text as delivery_date,
                        routing_total_weight,routing_weight_uom,outbound_total_pallets,
                        picked_pallet_details
                 from portal_orders where order_code=$1 for update`, [orderCode]);
            const row = order.rows[0];
            if (order.rowCount !== 1 || row.account_name !== account || row.status !== "STAGED" ||
                String(row.fulfillment_location_id) !== "143" || row.shipped_at ||
                row.shipped_carrier_name !== "Truck 4 Delivery" ||
                String(row.requested_ship_date).slice(0, 10) !== "2026-09-30" ||
                row.delivery_date || Number(row.routing_total_weight) !== 9245 ||
                row.routing_weight_uom !== "LB" || Number(row.outbound_total_pallets) !== 4) {
                throw new Error("Staged order or appointment facts changed since BOL review");
            }
            const pallets = row.picked_pallet_details || [];
            if (pallets.length !== 4 || pallets.some((pallet, index) =>
                pallet.location !== locations[index] || Number(pallet.weight) !== weights[index])) {
                throw new Error("Pallet locations or weights changed since BOL review");
            }
            const lines = await client.query(
                "select sku,requested_quantity from portal_order_lines where order_id=$1", [row.id]);
            if (lines.rowCount !== 1 || lines.rows[0].sku !== "MS26060402G" ||
                Number(lines.rows[0].requested_quantity) !== 4) {
                throw new Error("Order SKU or quantity changed since BOL review");
            }
            const shipment = await client.query(
                `select id,status,account_name,fulfillment_location_id,carrier_name,
                        total_pallets,total_weight,weight_uom,delivery_date
                 from warehouse_shipments where order_id=$1 for update`, [row.id]);
            const s = shipment.rows[0];
            if (shipment.rowCount !== 1 || s.status !== "STAGED" || s.account_name !== account ||
                String(s.fulfillment_location_id) !== "143" || s.carrier_name !== "Truck 4 Delivery" ||
                Number(s.total_pallets) !== 4 || Number(s.total_weight) !== 9245 ||
                s.weight_uom !== "LB" || s.delivery_date) {
                throw new Error("Warehouse shipment changed since BOL review");
            }
            const recipientProof = await client.query(
                `select id from email_delivery_log
                 where source_type='PORTAL_ORDER_BOL' and source_ref='ORD-001204'
                   and status='SENT' and bcc_addresses @> $1::jsonb limit 1`,
                [JSON.stringify(bcc)]);
            if (recipientProof.rowCount !== 1) throw new Error("Dhruv's prior BOL recipient could not be verified");
            const firstSend = await client.query(
                `select id from email_delivery_log
                 where delivery_key='owner-ord-001338-bol-dhruv-20260929-v1'
                   and status='SENT' and bcc_addresses @> $1::jsonb limit 1`,
                [JSON.stringify(bcc)]);
            if (firstSend.rowCount !== 1) throw new Error("The original BOL send was not verified");
            const previous = await client.query(
                "select status,message_id from email_delivery_log where delivery_key=$1", [key]);
            if (previous.rowCount) {
                if (previous.rows[0].status === "SENT") {
                    await client.query("rollback");
                    console.log(JSON.stringify({ alreadySent: true, messageId: previous.rows[0].message_id }));
                    return;
                }
                throw new Error("A prior BOL email attempt needs review; refusing duplicate send");
            }
            const existingDocument = await client.query(
                "select id,file_data from portal_order_documents where order_id=$1 and file_name=$2",
                [row.id, filename]);
            if (existingDocument.rowCount > 1 || (existingDocument.rowCount === 1 &&
                !Buffer.from(existingDocument.rows[0].file_data).equals(pdf))) {
                throw new Error("An existing BOL attachment conflicts with the reviewed PDF");
            }
            if (!apply) {
                await client.query("rollback");
                console.log(JSON.stringify({ order: orderCode, status: row.status,
                    recipientVerified: true, duplicate: false,
                    existingAttachment: existingDocument.rowCount === 1,
                    pdfSha256: hash, deliveryAppointment: "NOT_CONFIRMED" }));
                return;
            }
            if (existingDocument.rowCount === 1) {
                documentId = existingDocument.rows[0].id;
            } else {
                const document = await client.query(
                    `insert into portal_order_documents
                     (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
                     values($1,$2,'application/pdf',$3,$4,'GENERAL',$5,$6) returning id`,
                    [row.id, filename, pdf.length, pdf,
                        "WMS365 Support - corrected unsigned pre-shipment BOL, revision 2", s.id]);
                documentId = document.rows[0].id;
            }
            const claim = await client.query(
                `insert into email_delivery_log
                 (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
                  subject,account_name,source_type,source_ref,delivery_key,metadata)
                 values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,
                        'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
                 on conflict(delivery_key) do nothing returning id`,
                [from, JSON.stringify(to), JSON.stringify(bcc), "support@wms365.co", subject,
                    account, orderCode, key, JSON.stringify({ pdfSha256: hash, filename,
                        documentId, carrier: "Truck 4 Delivery", requestedShipDate: "2026-09-30",
                        deliveryAppointment: "NOT_CONFIRMED", pallets: 4, weightKg: 4193.46,
                        batchReference: "MS26062403", orderStatus: "STAGED", revision: 2,
                        supersedesDeliveryKey: "owner-ord-001338-bol-dhruv-20260929-v1" })]);
            if (claim.rowCount !== 1) throw new Error("BOL email idempotency claim failed");
            logId = claim.rows[0].id;
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        }

        const body = [
            "Hello Dhruv,", "",
            "Attached is the corrected unsigned pre-shipment BOL for Alcona order ORD-001338 (PO 529672).",
            "This revision replaces the earlier BOL. It shows only batch/lot MS26062403.",
            "Carrier: Truck 4 Delivery",
            "Freight: 4 pallets / 4 totes, 4,193.46 kg total; individual pallet weights are on the BOL.",
            "Batch/lot: MS26062403.",
            "Shipping reference: S2607S00390117",
            "Requested ship date: September 30, 2026.",
            "The delivery appointment is not confirmed in WMS365. Please coordinate with Nutem receiving before dispatch.",
            "The order remains staged; the driver and receiver signatures are pending.", "",
            "Regards,", "Grey Wolf 3PL & Logistics Inc."
        ].join("\n");
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json", "Idempotency-Key": key },
            body: JSON.stringify({ from, to, bcc, reply_to: "support@wms365.co",
                subject, text: body,
                attachments: [{ filename, content: pdf.toString("base64") }] }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) {
            await client.query(
                `update email_delivery_log set status='FAILED',error_message=$2,
                 failed_at=now(),updated_at=now() where id=$1`,
                [logId, `BOL provider rejected request (${response.status})`]);
            throw new Error(`BOL email was not accepted by the provider (${response.status})`);
        }
        await client.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
             sent_at=now(),updated_at=now() where id=$1`,
            [logId, payload.id, "Resend accepted unsigned pre-shipment BOL with attachment"]);
        const check = await client.query(
            `select o.status,o.shipped_at,e.status as email_status,e.message_id,e.bcc_addresses
             from portal_orders o join email_delivery_log e on e.delivery_key=$2 where o.order_code=$1`,
            [orderCode, key]);
        const result = check.rows[0];
        if (check.rowCount !== 1 || result.status !== "STAGED" || result.shipped_at ||
            result.email_status !== "SENT" || result.message_id !== payload.id ||
            JSON.stringify(result.bcc_addresses) !== JSON.stringify(bcc)) {
            throw new Error("Provider accepted the email, but WMS post-send verification needs review");
        }
        console.log(JSON.stringify({ order: orderCode, status: result.status,
            bolEmail: result.email_status, messageId: result.message_id,
            bccCount: bcc.length, documentId, pdfSha256: hash }));
    } finally {
        await client.end();
    }
}

module.exports = { main };
if (require.main === module) main(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
