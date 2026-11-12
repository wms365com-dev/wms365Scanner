"use strict";

const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "HEALTEA";
const RECIPIENT = "commande@thehealtea.com";
const SYSTEM_TO = "support@wms365.co";
const TYPE = "PORTAL_KITTING_STATUS";
const PROJECTS = [
  { code: "KIT-000022", sourceSku: "20628693486136", consumed: 10,
    targetSku: "628693486132", produced: 60, targetOnHand: 71 },
  { code: "KIT-000023", sourceSku: "20628693486150", consumed: 12,
    targetSku: "628693486156", produced: 72, targetOnHand: 76 },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  const pendingLogIds = [];
  try {
    const [contact, preferences] = await Promise.all([
      pool.query(
        `select email,is_active from portal_vendor_access
          where account_name=$1 and lower(email)=lower($2)`,
        [ACCOUNT, RECIPIENT]
      ),
      pool.query(
        `select email,notification_type,is_subscribed from customer_email_preferences
          where account_name=$1 and lower(email) in (lower($2),'*')
            and notification_type in ($3,'*')`,
        [ACCOUNT, RECIPIENT, TYPE]
      ),
    ]);
    if (contact.rowCount !== 1 || contact.rows[0].is_active !== true) {
      throw new Error("The verified HEALTEA requester is not an active assigned contact.");
    }
    if (preferences.rows.some((row) => row.is_subscribed === false)) {
      throw new Error("The HEALTEA contact or account is opted out of kitting status notices.");
    }

    const notices = [];
    for (const expected of PROJECTS) {
      const [requestResult, ledgerResult, stockResult, existingResult] = await Promise.all([
        pool.query(
          `select request_code,status,requested_by_email,completed_at,target_sku,target_quantity
             from portal_kitting_requests where account_name=$1 and request_code=$2`,
          [ACCOUNT, expected.code]
        ),
        pool.query(
          `select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions
            where source_type='PORTAL_KITTING_REQUEST' and source_id=$1
            group by sku`,
          [expected.code]
        ),
        pool.query(
          `select coalesce(sum(quantity),0)::integer on_hand from inventory_lines
            where account_name=$1 and sku=$2`,
          [ACCOUNT, expected.targetSku]
        ),
        pool.query("select status,message_id from email_delivery_log where delivery_key=$1",
          [`HEALTEA-${expected.code}-COMPLETED-20261028`]),
      ]);
      const request = requestResult.rows[0];
      const ledger = Object.fromEntries(ledgerResult.rows.map((row) => [row.sku, Number(row.quantity_delta)]));
      if (requestResult.rowCount !== 1 || request.status !== "COMPLETED" || !request.completed_at
        || String(request.requested_by_email).toLowerCase() !== RECIPIENT
        || request.target_sku !== expected.targetSku || Number(request.target_quantity) !== expected.produced
        || ledger[expected.sourceSku] !== -expected.consumed || ledger[expected.targetSku] !== expected.produced
        || Number(stockResult.rows[0].on_hand) !== expected.targetOnHand) {
        throw new Error(`${expected.code} did not pass the pre-email completion verification.`);
      }
      notices.push({ expected, duplicate: existingResult.rows[0]?.status === "SENT" });
    }

    if (!APPLY) {
      console.log(JSON.stringify({ ready: true, sent: false, notices: notices.map((notice) => ({
        request: notice.expected.code, duplicatePrevented: notice.duplicate,
      })), recipientCount: 1, toSystemAddress: true, ccCount: 0, bccOnly: true }));
      return;
    }
    if (!process.env.RESEND_API_KEY) throw new Error("The production email provider is not configured.");

    const sent = [];
    for (const notice of notices) {
      const expected = notice.expected;
      if (notice.duplicate) {
        sent.push({ request: expected.code, duplicatePrevented: true, providerAccepted: true });
        continue;
      }
      const deliveryKey = `HEALTEA-${expected.code}-COMPLETED-20261028`;
      const subject = `Kitting Project Completed - ${expected.code}`;
      const text = [
        "Hello HEALTEA team,", "",
        `Kitting project ${expected.code} has been completed in WMS365.`, "",
        `Component SKU: ${expected.sourceSku}`,
        `Component quantity consumed: ${expected.consumed} cases`,
        `Finished SKU: ${expected.targetSku}`,
        `Finished quantity produced: ${expected.produced} cases`,
        `Current finished inventory: ${expected.targetOnHand} cases`,
        "Warehouse: Grey Wolf 3PL - Mississauga", "",
        "The finished inventory is available for picking.", "",
        "Regards,", "WMS365 Support",
      ].join("\n");
      const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55">
<p>Hello HEALTEA team,</p><p>Kitting project <strong>${expected.code}</strong> has been completed in WMS365.</p>
<table style="border-collapse:collapse;width:100%;max-width:680px">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Component SKU</td><td style="padding:8px;border:1px solid #d9e2e8">${expected.sourceSku}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Component quantity consumed</td><td style="padding:8px;border:1px solid #d9e2e8">${expected.consumed} cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished SKU</td><td style="padding:8px;border:1px solid #d9e2e8">${expected.targetSku}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished quantity produced</td><td style="padding:8px;border:1px solid #d9e2e8">${expected.produced} cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Current finished inventory</td><td style="padding:8px;border:1px solid #d9e2e8">${expected.targetOnHand} cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Warehouse</td><td style="padding:8px;border:1px solid #d9e2e8">Grey Wolf 3PL - Mississauga</td></tr>
</table><p>The finished inventory is available for picking.</p><p>Regards,<br>WMS365 Support</p></body></html>`;
      const log = await pool.query(
        `insert into email_delivery_log (
           status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
           account_name,source_type,source_ref,delivery_key,metadata
         ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                   $3,$4,$5,$6,$7,$8,$9::jsonb)
         on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now()
         returning id`,
        [JSON.stringify([SYSTEM_TO]), JSON.stringify([RECIPIENT]), SYSTEM_TO, subject,
          ACCOUNT, TYPE, expected.code, deliveryKey,
          JSON.stringify({ targetSku: expected.targetSku, completedQuantity: expected.produced,
            availableQuantity: expected.targetOnHand, audience: "CUSTOMER_BCC_ONLY",
            addressingPolicy: "CUSTOMER_BCC_ONLY" })]
      );
      const logId = log.rows[0].id;
      pendingLogIds.push(logId);
      try {
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json", "Idempotency-Key": deliveryKey },
          body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: [SYSTEM_TO], cc: [],
            bcc: [RECIPIENT], reply_to: SYSTEM_TO, subject, text, html }),
          signal: AbortSignal.timeout(30000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await pool.query(
          `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
                  sent_at=now(),updated_at=now() where id=$1`,
          [logId, payload.id, "Resend accepted the BCC-only HEALTEA kitting notice."]
        );
        pendingLogIds.splice(pendingLogIds.indexOf(logId), 1);
        sent.push({ request: expected.code, duplicatePrevented: false, providerAccepted: true });
      } catch (error) {
        await pool.query(
          `update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
          [logId, String(error.message || error).slice(0, 2000)]
        ).catch(() => {});
        throw error;
      }
    }
    console.log(JSON.stringify({ sent: true, notices: sent, recipientCount: 1,
      toSystemAddress: true, ccCount: 0, bccOnly: true }));
  } finally {
    await pool.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
