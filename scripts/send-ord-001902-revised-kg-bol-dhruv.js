"use strict";

const crypto = require("node:crypto");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001902";
const ACCOUNT = "ALCONA TRADING LTD";
const FILE = "WMS365_BOL_ORD-001902_2026-11-05_1130AM_BISON_REVISED_KG.pdf";
const KEY = "owner-ord-001902-bol-dhruv-20261105-revised-kg-v1";
const FROM = "WMS365 <support@wms365.co>";
const TO = ["support@wms365.co"];
const CC = [];
const BCC = ["d.jain@emotrans-canada.com"];
const SUBJECT = "Revised KG BOL - Alcona ORD-001902 / PO 529674 - Nov 5 confirmed delivery";

async function main() {
    if (!process.env.RESEND_API_KEY) throw new Error("Email provider unavailable.");
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    let logId = null;
    try {
        await db.query("begin");
        const result = await db.query(`
            select o.id,o.status,o.account_name,o.po_number,o.shipped_carrier_name,
                   o.routing_total_weight,o.routing_weight_uom,o.picked_pallet_details,
                   s.status shipment_status,s.carrier_name,s.total_pallets,s.total_weight,s.weight_uom,
                   s.delivery_date::text,r.status appointment_status,r.appointment_date::text,
                   r.window_start::text,r.window_end::text,r.responded_at,
                   d.id document_id,d.file_data
            from portal_orders o
            join warehouse_shipments s on s.order_id=o.id
            join order_routing_requests r on r.order_id=o.id
            join portal_order_documents d on d.order_id=o.id
              and d.file_name=$2 and d.document_category='SHIPMENT_BOL'
            where o.order_code=$1
            order by s.id desc,r.id desc limit 1
            for update of o,s
        `, [CODE, FILE]);
        if (result.rowCount !== 1) throw new Error("Exact order, shipment, appointment, and revised BOL were not found.");
        const row = result.rows[0];
        const pallets = Array.isArray(row.picked_pallet_details) ? row.picked_pallet_details : [];
        if (row.account_name !== ACCOUNT || row.status !== "SHIPPED" || row.shipment_status !== "SHIPPED"
            || row.po_number !== "529674" || row.shipped_carrier_name !== "Bison" || row.carrier_name !== "Bison"
            || Number(row.total_pallets) !== 4 || row.routing_weight_uom !== "KG" || row.weight_uom !== "KG"
            || Number(row.routing_total_weight) !== 4213.87 || Number(row.total_weight) !== 4213.87
            || pallets.length !== 4 || pallets.some((p) => p.weightUom !== "KG")
            || String(row.delivery_date).slice(0, 10) !== "2026-11-05"
            || row.appointment_status !== "CONFIRMED" || !row.responded_at
            || String(row.appointment_date).slice(0, 10) !== "2026-11-05"
            || !String(row.window_start).startsWith("11:30") || !String(row.window_end).startsWith("12:00")) {
            throw new Error("Live order, shipment, appointment, or KG details no longer match the reviewed BOL.");
        }
        const pdfHash = crypto.createHash("sha256").update(row.file_data).digest("hex");
        if (pdfHash !== "01b734e383a7bfe31b9d18c46e3d23e03bdc6b8241ba8a0d1f9b93973e49662b") {
            throw new Error("Revised BOL content hash changed.");
        }
        const recipientProof = await db.query(`
            select id from email_delivery_log
            where account_name=$1 and status='SENT'
              and (to_addresses @> $2::jsonb or cc_addresses @> $2::jsonb or bcc_addresses @> $2::jsonb)
            limit 1
        `, [ACCOUNT, JSON.stringify(BCC)]);
        if (recipientProof.rowCount !== 1) throw new Error("Approved Dhruv recipient identity could not be verified.");
        const prior = await db.query("select status,message_id from email_delivery_log where delivery_key=$1", [KEY]);
        if (prior.rowCount) {
            await db.query("rollback");
            if (prior.rows[0].status === "SENT") {
                console.log(JSON.stringify({ alreadySent: true, order: CODE, messageId: prior.rows[0].message_id }));
                return;
            }
            throw new Error("A prior revised-KG send attempt requires review.");
        }
        if (!APPLY) {
            await db.query("rollback");
            console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, status: row.status,
                appointmentStatus: row.appointment_status, totalKg: 4213.87, palletCount: 4,
                toCount: 1, ccCount: 0, bccCount: 1, pdfHash }));
            return;
        }
        const claim = await db.query(`
            insert into email_delivery_log
              (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
               subject,account_name,source_type,source_ref,delivery_key,metadata)
            values('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,$4::jsonb,'support@wms365.co',
               $5,$6,'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
            on conflict(delivery_key) do nothing returning id
        `, [FROM, JSON.stringify(TO), JSON.stringify(CC), JSON.stringify(BCC), SUBJECT,
            ACCOUNT, CODE, KEY, JSON.stringify({ documentId: row.document_id, filename: FILE,
                pdfHash, carrier: "Bison", totalKg: 4213.87, appointmentStatus: "CONFIRMED",
                addressing: "BCC_ONLY", correction: "KG_ONLY" })]);
        if (claim.rowCount !== 1) throw new Error("Email idempotency claim failed.");
        logId = claim.rows[0].id;
        await db.query("commit");

        const text = [
            "Hello Dhruv,", "",
            "Attached is the corrected kilograms-only BOL for Alcona order ORD-001902 (PO 529674).",
            "Carrier: Bison.",
            "Confirmed delivery: November 5, 2026, 11:30 AM to 12:00 PM Eastern.",
            "Four pallets, total weight 4,213.87 kg.",
            "Please use this revised KG version in place of the earlier pounds version.", "",
            "Regards", "Grey Wolf 3PL & Logistics Inc."
        ].join("\n");
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": KEY },
            body: JSON.stringify({ from: FROM, to: TO, cc: CC, bcc: BCC, reply_to: "support@wms365.co",
                subject: SUBJECT, text, attachments: [{ filename: FILE, content: Buffer.from(row.file_data).toString("base64") }] }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) {
            await db.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",
                [logId, `Provider rejected revised KG BOL (${response.status})`]);
            throw new Error(`Email provider rejected the revised BOL (${response.status}).`);
        }
        await db.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
            sent_at=now(),updated_at=now() where id=$1`, [logId, payload.id, "Resend accepted revised KG BOL"]);
        const final = (await db.query("select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where id=$1", [logId])).rows[0];
        if (final.status !== "SENT" || final.message_id !== payload.id
            || JSON.stringify(final.to_addresses) !== JSON.stringify(TO)
            || JSON.stringify(final.cc_addresses) !== "[]"
            || JSON.stringify(final.bcc_addresses) !== JSON.stringify(BCC)) {
            throw new Error("Final email envelope verification failed.");
        }
        console.log(JSON.stringify({ mode: "SENT", order: CODE, status: row.status,
            appointmentStatus: row.appointment_status, totalKg: 4213.87, messageId: payload.id,
            toCount: 1, ccCount: 0, bccCount: 1, pdfHash }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
