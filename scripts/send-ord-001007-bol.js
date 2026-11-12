const crypto = require("node:crypto");
const { Client } = require("pg");

const ORDER_ID = 1007;
const ORDER_CODE = "ORD-001007";
const ACCOUNT = "ALCONA TRADING LTD";
const CARRIER = "Truck 4 Delivery";
const SUBJECT = "BOL - ORD-001007 - Alcona - September 23 delivery";
const KEY = "owner-ord-001007-bol-prathab-20260923-v1";
const FROM = "WMS365 <support@wms365.co>";
const BCC = ["prathab@greywolf3pl.com"];
const FILENAME = "WMS365_BOL_ORD-001007_2026-09-23.pdf";
const EXPECTED_HASH = "d66199f1c51665a9f9b783d73e782cf1424b90ea4630f021f2b0414a70b6deb2";

async function main(pdfBase64) {
    if (!process.env.RESEND_API_KEY) throw new Error("Resend email provider is unavailable.");
    const pdf = Buffer.from(String(pdfBase64 || ""), "base64");
    if (pdf.subarray(0, 4).toString() !== "%PDF"
        || crypto.createHash("sha256").update(pdf).digest("hex") !== EXPECTED_HASH) {
        throw new Error("The attachment does not match the visually checked BOL.");
    }
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await client.connect();
    let logId;
    try {
        await client.query("begin");
        try {
            const result = await client.query(
                `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                        o.picked_at,o.staged_at,o.shipped_at,o.shipped_carrier_name,
                        o.routing_requested_delivery_date::text as routing_requested_delivery_date,
                        o.routing_total_weight,o.routing_weight_uom,
                        o.outbound_total_pallets
                 from portal_orders o where o.id=$1 for update`, [ORDER_ID]
            );
            const order = result.rows[0];
            if (result.rowCount !== 1 || order.order_code !== ORDER_CODE || order.account_name !== ACCOUNT
                || String(order.fulfillment_location_id) !== "143" || order.status !== "STAGED"
                || !order.picked_at || !order.staged_at || order.shipped_at
                || String(order.routing_requested_delivery_date).slice(0, 10) !== "2026-09-23"
                || Number(order.routing_total_weight) !== 9243 || order.routing_weight_uom !== "LB"
                || Number(order.outbound_total_pallets) !== 4) {
                throw new Error("The staged order no longer matches the BOL review.");
            }
            const shipments = await client.query(
                `select id,status,account_name,fulfillment_location_id from warehouse_shipments
                 where order_id=$1 for update`, [ORDER_ID]
            );
            if (shipments.rowCount !== 1 || shipments.rows[0].status !== "STAGED"
                || shipments.rows[0].account_name !== ACCOUNT
                || String(shipments.rows[0].fulfillment_location_id) !== "143") {
                throw new Error("The staged warehouse shipment changed.");
            }
            const previous = await client.query("select id,status,message_id from email_delivery_log where delivery_key=$1", [KEY]);
            if (previous.rowCount) {
                if (previous.rows[0].status === "SENT") {
                    await client.query("rollback");
                    console.log(JSON.stringify({ alreadySent: true, messageId: previous.rows[0].message_id || "" }));
                    return;
                }
                throw new Error("A prior BOL email attempt needs manual review before retrying.");
            }
            const claim = await client.query(
                `insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,
                        reply_to,subject,account_name,source_type,source_ref,delivery_key,metadata)
                 values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
                 on conflict(delivery_key) do nothing returning id`,
                [FROM, JSON.stringify(["support@wms365.co"]), JSON.stringify(BCC), "support@wms365.co",
                    SUBJECT, ACCOUNT, ORDER_CODE, KEY, JSON.stringify({
                        pdfSha256: EXPECTED_HASH, filename: FILENAME, carrier: CARRIER,
                        appointment: "2026-09-23 11:00 AM ET", pallets: 4, weightKg: 4192.554,
                        warehouseReportedBatch: "MS26062403", inventoryReconciliationPending: true
                    })]
            );
            if (claim.rowCount !== 1) throw new Error("BOL email idempotency claim failed.");
            logId = claim.rows[0].id;
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        }

        const text = [
            "Hello Prathab,", "",
            "Attached is the bill of lading for Alcona order ORD-001007 (PO 529671).",
            "Carrier: Truck 4 Delivery",
            "Delivery appointment: September 23, 2026 at 11:00 AM Eastern",
            "Destination: Nutem Custom Manufacturing, 1105 Clay Ave, Unit 7, Burlington, ON L7L 0A1",
            "Freight: 4 pallets, 4,192.6 kg total. Individual pallet weights are on the BOL.",
            "EMO reference: S2607S00387647", "",
            "Please review before forwarding: the warehouse-reported batch and pick bins on this BOL do not yet match the WMS inventory allocations. No inventory was changed.",
            "", "Regards,", "Grey Wolf 3PL & Logistics Inc."
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
            await client.query(
                "update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",
                [logId, `BOL provider rejected request (${response.status})`]
            );
            throw new Error(`BOL email was not accepted by the provider (${response.status}).`);
        }
        await client.query(
            "update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1",
            [logId, payload.id, "Resend accepted BOL email with attachment"]
        );
        const verified = await client.query(
            `select o.status,o.picked_at,o.staged_at,o.shipped_at,o.shipped_carrier_name,
                    e.status email_status,e.message_id,e.sent_at,e.bcc_addresses,
                    s.carrier_name shipment_carrier
             from portal_orders o join warehouse_shipments s on s.order_id=o.id
             join email_delivery_log e on e.delivery_key=$2 where o.id=$1`, [ORDER_ID, KEY]
        );
        const row = verified.rows[0];
        if (verified.rowCount !== 1 || row.status !== "STAGED" || !row.picked_at || !row.staged_at
            || row.shipped_at
            || row.email_status !== "SENT" || row.message_id !== payload.id
            || JSON.stringify(row.bcc_addresses) !== JSON.stringify(BCC)) {
            throw new Error("BOL email accepted, but the final WMS/email verification needs review.");
        }
        console.log(JSON.stringify({ order: ORDER_CODE, orderStatus: row.status,
            carrier: row.shipped_carrier_name, bolEmail: row.email_status, providerMessageId: row.message_id,
            bccCount: BCC.length, attachmentSha256: EXPECTED_HASH, inventoryUpdated: false }));
    } finally {
        await client.end();
    }
}

module.exports = { main };
