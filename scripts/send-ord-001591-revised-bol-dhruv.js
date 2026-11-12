"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001591", ACCOUNT = "ALCONA TRADING LTD";
const FILE = "WMS365_BOL_ORD-001591_2026-10-22_10AM_REVISED.pdf";
const PDF_PATH = path.resolve(__dirname, "..", "outputs", "ord-001591-bol", FILE);
const KEY = "owner-ord-001591-bol-dhruv-20261022-10am-bison-rev1";
const FROM = "WMS365 <support@wms365.co>", TO = ["support@wms365.co"], CC = [], BCC = ["d.jain@emotrans-canada.com"];
const SUBJECT = "Revised BOL - Alcona ORD-001591 / PO 529673 - Oct 22, 10 AM delivery";
async function main() {
  if (!process.env.RESEND_API_KEY) throw new Error("Email provider unavailable.");
  const pdf = fs.readFileSync(PDF_PATH), hash = crypto.createHash("sha256").update(pdf).digest("hex");
  const db = new Client({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL, ssl: false }); await db.connect(); let logId;
  try {
    await db.query("begin");
    const q = await db.query(`select o.id,o.status,o.shipped_at,o.account_name,o.po_number,o.shipped_carrier_name,o.picked_pallet_details,
      s.status shipment_status,s.carrier_name,s.total_weight,s.weight_uom,s.delivery_date::text,r.appointment_date::text,r.window_start,
      d.id document_id,d.file_data from portal_orders o join warehouse_shipments s on s.order_id=o.id
      join order_routing_requests r on r.order_id=o.id and r.status='CONFIRMED'
      join portal_order_documents d on d.order_id=o.id and d.file_name=$2 and d.document_category='SHIPMENT_BOL'
      where o.order_code=$1 for update of o,s`, [CODE, FILE]);
    if (q.rowCount !== 1) throw new Error("Revised order, BOL, shipment, or appointment identity is not unique."); const o = q.rows[0];
    const pallets = o.picked_pallet_details || [], locations = ["DJ36AA", "DJ30AA", "DJ36AC", "DJ34AC"];
    if (o.account_name !== ACCOUNT || o.status !== "STAGED" || o.shipment_status !== "STAGED" || o.shipped_at || o.po_number !== "529673"
      || o.shipped_carrier_name !== "Bison" || o.carrier_name !== "Bison" || Number(o.total_weight) !== 4195.73 || o.weight_uom !== "KG"
      || String(o.delivery_date).slice(0, 10) !== "2026-10-22" || String(o.appointment_date).slice(0, 10) !== "2026-10-22"
      || String(o.window_start).slice(0, 5) !== "10:00" || pallets.length !== 4 || pallets.some((p, i) => p.location !== locations[i])) throw new Error("Live revised order details changed.");
    if (crypto.createHash("sha256").update(o.file_data).digest("hex") !== hash) throw new Error("Stored revised BOL hash mismatch.");
    const proof = await db.query(`select id from email_delivery_log where status='SENT' and
      (to_addresses @> $1::jsonb or cc_addresses @> $1::jsonb or bcc_addresses @> $1::jsonb) limit 1`, [JSON.stringify(BCC)]);
    if (proof.rowCount !== 1) throw new Error("Dhruv recipient identity could not be verified from prior sent mail.");
    const prior = await db.query("select status,message_id from email_delivery_log where delivery_key=$1", [KEY]);
    if (prior.rowCount) { if (prior.rows[0].status === "SENT") { await db.query("rollback"); console.log(JSON.stringify({ alreadySent: true, messageId: prior.rows[0].message_id })); return; } throw new Error("A prior revised email attempt requires review."); }
    if (!APPLY) { await db.query("rollback"); console.log(JSON.stringify({ ready: true, order: CODE, toCount: 1, ccCount: 0, bccCount: 1, pdfSha256: hash })); return; }
    const claim = await db.query(`insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
      account_name,source_type,source_ref,delivery_key,metadata) values('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,'PORTAL_ORDER_BOL',$8,$9,$10::jsonb)
      on conflict(delivery_key) do nothing returning id`, [FROM, JSON.stringify(TO), JSON.stringify(CC), JSON.stringify(BCC), "support@wms365.co", SUBJECT, ACCOUNT, CODE, KEY,
      JSON.stringify({ pdfSha256: hash, filename: FILE, documentId: o.document_id, carrier: "Bison", revisedLocation: "DJ34AC", supersedes: "Polar North Freight Lines / DJ30AC", addressing: "BCC_ONLY" })]);
    if (claim.rowCount !== 1) throw new Error("Revised email idempotency claim failed."); logId = claim.rows[0].id; await db.query("commit");
    const body = ["Hello Dhruv,", "", "Attached is the revised unsigned pre-shipment BOL for Alcona order ORD-001591 (PO 529673).",
      "This revision supersedes the prior BOL: the carrier is Bison and pallet 4 is located at DJ34AC.",
      "Delivery: October 22, 2026 at 10:00 AM Eastern.", "The order remains staged and has not been marked shipped.", "", "Regards,", "Grey Wolf 3PL & Logistics Inc."].join("\n");
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, { method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": KEY },
      body: JSON.stringify({ from: FROM, to: TO, cc: CC, bcc: BCC, reply_to: "support@wms365.co", subject: SUBJECT, text: body,
        attachments: [{ filename: FILE, content: pdf.toString("base64") }] }), signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) { await db.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1", [logId, `Provider rejected revised BOL (${response.status})`]); throw new Error(`Provider rejected revised BOL (${response.status}).`); }
    await db.query("update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1", [logId, payload.id, "Resend accepted revised BCC-only BOL email"]);
    const final = (await db.query("select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where id=$1", [logId])).rows[0];
    if (final.status !== "SENT" || final.message_id !== payload.id || JSON.stringify(final.to_addresses) !== JSON.stringify(TO)
      || JSON.stringify(final.cc_addresses) !== "[]" || JSON.stringify(final.bcc_addresses) !== JSON.stringify(BCC)) throw new Error("Final revised email envelope verification failed.");
    console.log(JSON.stringify({ order: CODE, status: "STAGED", emailStatus: "SENT", messageId: payload.id, toCount: 1, ccCount: 0, bccCount: 1, pdfSha256: hash }));
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { await db.end(); }
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
