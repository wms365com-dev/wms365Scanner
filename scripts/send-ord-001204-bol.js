const crypto = require("node:crypto");
const { Client } = require("pg");

const ORDER_ID = 1204;
const ORDER_CODE = "ORD-001204";
const ACCOUNT = "ALCONA TRADING LTD";
const KEY = "owner-ord-001204-bol-dhruv-20260928-v1";
const FROM = "WMS365 <support@wms365.co>";
const BCC = ["d.jain@emotrans-canada.com"];
const FILENAME = "WMS365_BOL_ORD-001204_2026-09-28.pdf";
const SUBJECT = "BOL - ORD-001204 - Alcona - September 28 delivery";

async function main(pdfBase64, expectedHash) {
    if (!process.env.RESEND_API_KEY) throw new Error("Resend email provider is unavailable.");
    const pdf = Buffer.from(String(pdfBase64 || ""), "base64");
    const hash = crypto.createHash("sha256").update(pdf).digest("hex");
    if (pdf.subarray(0, 4).toString() !== "%PDF" || !expectedHash || hash !== expectedHash) {
        throw new Error("The attachment does not match the reviewed BOL.");
    }
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection unavailable.");
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await client.connect();
    let logId;
    let carrier;
    try {
        await client.query("begin");
        try {
            const orderResult = await client.query(`select id,order_code,account_name,status,fulfillment_location_id,
                picked_at,staged_at,shipped_at,shipped_carrier_name,routing_requested_delivery_date::text as delivery_date,
                routing_total_weight,routing_weight_uom,outbound_total_pallets,picked_pallet_details
                from portal_orders where id=$1 for update`, [ORDER_ID]);
            const order = orderResult.rows[0];
            if (orderResult.rowCount !== 1 || order.order_code !== ORDER_CODE || order.account_name !== ACCOUNT
                || String(order.fulfillment_location_id) !== "143" || order.status !== "STAGED"
                || !order.picked_at || !order.staged_at || order.shipped_at
                || String(order.delivery_date).slice(0, 10) !== "2026-09-28"
                || Number(order.routing_total_weight) !== 9246 || order.routing_weight_uom !== "LB"
                || Number(order.outbound_total_pallets) !== 4
                || JSON.stringify((order.picked_pallet_details || []).map(p => p.location))
                    !== JSON.stringify(["DI04AA", "DI06AA", "DI08AA", "DI10AA"])) {
                throw new Error("The staged order no longer matches the reviewed BOL.");
            }
            carrier = order.shipped_carrier_name;
            if (!carrier) throw new Error("The carrier is not confirmed in WMS.");
            const shipments = await client.query(`select status,account_name,fulfillment_location_id,carrier_name,
                total_weight,weight_uom,delivery_date::text as delivery_date from warehouse_shipments
                where order_id=$1 for update`, [ORDER_ID]);
            if (shipments.rowCount !== 1 || shipments.rows[0].status !== "STAGED"
                || shipments.rows[0].account_name !== ACCOUNT
                || String(shipments.rows[0].fulfillment_location_id) !== "143"
                || shipments.rows[0].carrier_name !== carrier
                || Number(shipments.rows[0].total_weight) !== 9246
                || shipments.rows[0].weight_uom !== "LB"
                || String(shipments.rows[0].delivery_date).slice(0, 10) !== "2026-09-28") {
                throw new Error("The staged warehouse shipment changed.");
            }
            const recipientProof = await client.query(`select id from email_delivery_log
                where source_ref=$1 and source_type='PORTAL_ORDER_CONFIRMATION'
                  and status='SENT' and metadata->>'requestedBy'=$2
                  and to_addresses @> $3::jsonb limit 1`,
            [ORDER_CODE, BCC[0], JSON.stringify(BCC)]);
            if (recipientProof.rowCount !== 1) {
                throw new Error("Dhruv's address is not verified against this order's prior confirmation.");
            }
            const previous = await client.query("select status,message_id from email_delivery_log where delivery_key=$1", [KEY]);
            if (previous.rowCount) {
                if (previous.rows[0].status === "SENT") {
                    await client.query("rollback");
                    console.log(JSON.stringify({ alreadySent: true, messageId: previous.rows[0].message_id || "" }));
                    return;
                }
                throw new Error("A prior BOL email attempt needs review before retrying.");
            }
            const claim = await client.query(`insert into email_delivery_log(status,provider,from_address,
                to_addresses,cc_addresses,bcc_addresses,reply_to,subject,account_name,source_type,source_ref,
                delivery_key,metadata)
                values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,
                'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
                on conflict(delivery_key) do nothing returning id`, [FROM,
                JSON.stringify(["support@wms365.co"]), JSON.stringify(BCC), "support@wms365.co",
                SUBJECT, ACCOUNT, ORDER_CODE, KEY, JSON.stringify({
                    pdfSha256: hash, filename: FILENAME, carrier, appointment: "2026-09-28 1:00 PM ET",
                    pallets: 4, weightKg: 4193.915, inventoryReconciliationPending: true
                })]);
            if (claim.rowCount !== 1) throw new Error("BOL email idempotency claim failed.");
            logId = claim.rows[0].id;
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        }

        const text = [
            "Hello Dhruv,", "",
            "Attached is the bill of lading for Alcona order ORD-001204 (PO 529671).",
            `Carrier: ${carrier}`,
            "Delivery appointment: Monday, September 28, 2026 at 1:00 PM Eastern",
            "Destination: Nutem Custom Manufacturing, 1105 Clay Ave, Burlington, ON L7L 0A1",
            "Freight: 4 pallets, 4,193.9 kg total. Individual pallet weights are on the BOL.",
            "EMO reference: S2607S00390117", "",
            "Regards,", "Grey Wolf 3PL & Logistics Inc."
        ].join("\n");
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json", "Idempotency-Key": KEY },
            body: JSON.stringify({ from: FROM, to: ["support@wms365.co"], bcc: BCC,
                reply_to: "support@wms365.co", subject: SUBJECT, text,
                attachments: [{ filename: FILENAME, content: pdf.toString("base64") }] }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) {
            await client.query(`update email_delivery_log set status='FAILED',error_message=$2,
                failed_at=now(),updated_at=now() where id=$1`, [logId, `BOL provider rejected request (${response.status})`]);
            throw new Error(`BOL email was not accepted by the provider (${response.status}).`);
        }
        await client.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
            sent_at=now(),updated_at=now() where id=$1`, [logId, payload.id, "Resend accepted BOL email with attachment"]);
        const verified = await client.query(`select o.status,o.shipped_at,e.status email_status,e.message_id,
            e.bcc_addresses from portal_orders o join email_delivery_log e on e.delivery_key=$2
            where o.id=$1`, [ORDER_ID, KEY]);
        const row = verified.rows[0];
        if (verified.rowCount !== 1 || row.status !== "STAGED" || row.shipped_at
            || row.email_status !== "SENT" || row.message_id !== payload.id
            || JSON.stringify(row.bcc_addresses) !== JSON.stringify(BCC)) {
            throw new Error("Provider accepted BOL email, but WMS verification needs review.");
        }
        console.log(JSON.stringify({ order: ORDER_CODE, orderStatus: row.status,
            carrier, bolEmail: row.email_status, providerMessageId: row.message_id,
            bccCount: BCC.length, attachmentSha256: hash, inventoryUpdated: false }));
    } finally {
        await client.end();
    }
}

module.exports = { main };
if (require.main === module) main(process.argv[2], process.argv[3]).catch(error => {
    console.error(error.stack || error); process.exitCode = 1;
});
