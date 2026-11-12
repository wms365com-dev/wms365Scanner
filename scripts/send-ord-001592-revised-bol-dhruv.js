"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001592";
const ACCOUNT = "ALCONA TRADING LTD";
const FILE = "WMS365_BOL_ORD-001592_2026-10-26_11AM_BISON_CORRECTED.pdf";
const PDF_PATH = path.resolve(__dirname, "..", "outputs", "ord-001592-bol", FILE);
const KEY = "owner-ord-001592-bol-dhruv-20261026-11am-bison-corrected-window";
const FROM = "WMS365 <support@wms365.co>";
const TO = ["support@wms365.co"];
const CC = [];
const BCC = ["d.jain@emotrans-canada.com"];
const SUBJECT = "Corrected BOL - Alcona ORD-001592 / PO 529673 - Bison - Oct 26, 11 AM delivery window";
const LOCATIONS = ["DJ32AC", "DJ30AC", "DJ28AC", "DJ26AC"];
const TOTAL_KG = 4208.88;

async function main() {
  if (!process.env.RESEND_API_KEY) throw new Error("Email provider unavailable.");
  const pdf = fs.readFileSync(PDF_PATH);
  const hash = crypto.createHash("sha256").update(pdf).digest("hex");
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let logId;
  try {
    await db.query("begin");
    const q = await db.query(`select o.*,s.status shipment_status,s.carrier_name shipment_carrier,
      s.total_weight shipment_weight,s.weight_uom shipment_weight_uom,s.delivery_date::text delivery_date,
      r.status appointment_status,r.appointment_date::text appointment_date,r.window_start,r.window_end,
      d.id document_id,d.file_data from portal_orders o join warehouse_shipments s on s.order_id=o.id
      join order_routing_requests r on r.order_id=o.id join portal_order_documents d on d.order_id=o.id
      and d.file_name=$2 and d.document_category='SHIPMENT_BOL' where o.order_code=$1 for update of o,s`, [CODE, FILE]);
    if (q.rowCount !== 1) throw new Error("Revised order, shipment, routing, or BOL identity is not unique.");
    const o = q.rows[0];
    if (o.account_name !== ACCOUNT || o.status !== "STAGED" || o.shipment_status !== "STAGED" || o.shipped_at
      || o.shipped_carrier_name !== "Bison" || o.shipment_carrier !== "Bison"
      || Number(o.routing_total_weight) !== TOTAL_KG || Number(o.shipment_weight) !== TOTAL_KG
      || o.routing_weight_uom !== "KG" || o.shipment_weight_uom !== "KG"
      || String(o.delivery_date).slice(0, 10) !== "2026-10-26" || String(o.appointment_date).slice(0, 10) !== "2026-10-26"
      || o.appointment_status !== "CONFIRMED" || String(o.window_start).slice(0, 5) !== "10:00"
      || String(o.window_end).slice(0, 5) !== "11:00") throw new Error("Live revised order details changed.");
    const pallets = o.picked_pallet_details || [];
    if (pallets.length !== 4 || pallets.some((p, i) => p.location !== LOCATIONS[i] || p.weightUom !== "KG")) throw new Error("Pallet details changed.");
    if (crypto.createHash("sha256").update(o.file_data).digest("hex") !== hash) throw new Error("Stored revised BOL hash mismatch.");
    const prior = await db.query("select status,message_id from email_delivery_log where delivery_key=$1", [KEY]);
    if (prior.rowCount) {
      await db.query("rollback");
      if (prior.rows[0].status === "SENT") return console.log(JSON.stringify({ alreadySent: true, messageId: prior.rows[0].message_id }));
      throw new Error("A prior revised BOL email attempt requires review.");
    }
    if (!APPLY) {
      await db.query("rollback");
      console.log(JSON.stringify({ ready: true, order: CODE, appointmentStatus: o.appointment_status,
        toCount: 1, ccCount: 0, bccCount: 1, pdfSha256: hash }));
      return;
    }
    const claim = await db.query(`insert into email_delivery_log
      (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
       account_name,source_type,source_ref,delivery_key,metadata)
      values('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,'PORTAL_ORDER_BOL',$8,$9,$10::jsonb)
      on conflict(delivery_key) do nothing returning id`, [FROM, JSON.stringify(TO), JSON.stringify(CC), JSON.stringify(BCC),
      "support@wms365.co", SUBJECT, ACCOUNT, CODE, KEY, JSON.stringify({ pdfSha256: hash, filename: FILE,
        documentId: o.document_id, carrier: "Bison", totalKg: TOTAL_KG, requestedDeliveryDate: "2026-10-26",
        requestedDeliveryTimeEt: "11:00", addressing: "BCC_ONLY", supersedes: "carrier to be confirmed BOL" })]);
    if (claim.rowCount !== 1) throw new Error("Revised BOL email claim failed.");
    logId = claim.rows[0].id;
    await db.query("commit");
    const body = ["Hello Dhruv,", "", "Attached is the corrected unsigned pre-shipment BOL for Alcona order ORD-001592 (PO 529673).",
      "This correction shows the confirmed 10:00-11:00 AM ET delivery window and carrier Bison, and replaces the earlier BOL.",
      "Confirmed delivery window: October 26, 2026 from 10:00 to 11:00 AM Eastern.",
      "Four pallets total 4,208.88 kg; individual pallet weights and pick locations are shown on the BOL.",
      "The order remains staged and has not been marked shipped.", "", "Regards,", "Grey Wolf 3PL & Logistics Inc."].join("\n");
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": KEY },
      body: JSON.stringify({ from: FROM, to: TO, cc: CC, bcc: BCC, reply_to: "support@wms365.co", subject: SUBJECT,
        text: body, attachments: [{ filename: FILE, content: pdf.toString("base64") }] }), signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      await db.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1", [logId, `Provider rejected revised BOL (${response.status})`]);
      throw new Error(`Provider rejected revised BOL email (${response.status}).`);
    }
    await db.query("update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1",
      [logId, payload.id, "Resend accepted revised BCC-only BOL email"]);
    const final = (await db.query("select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where id=$1", [logId])).rows[0];
    if (final.status !== "SENT" || final.message_id !== payload.id || JSON.stringify(final.to_addresses) !== JSON.stringify(TO)
      || JSON.stringify(final.cc_addresses) !== "[]" || JSON.stringify(final.bcc_addresses) !== JSON.stringify(BCC)) throw new Error("Final revised email verification failed.");
    console.log(JSON.stringify({ order: CODE, status: "STAGED", carrier: "Bison", emailStatus: "SENT",
      messageId: payload.id, toCount: 1, ccCount: 0, bccCount: 1, pdfSha256: hash }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
