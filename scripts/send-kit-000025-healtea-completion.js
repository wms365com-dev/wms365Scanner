"use strict";

const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "HEALTEA";
const CODE = "KIT-000025";
const RECIPIENT = "commande@thehealtea.com";
const SYSTEM_TO = "support@wms365.co";
const DELIVERY_KEY = "HEALTEA-KIT-000025-COMPLETED-20261028";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  let logId = null;
  try {
    const [requestResult, contactResult, preferenceResult, ledgerResult, stockResult, existingResult] = await Promise.all([
      pool.query(`select status,requested_by_email,completed_at,target_sku,target_quantity from portal_kitting_requests where account_name=$1 and request_code=$2`, [ACCOUNT, CODE]),
      pool.query(`select email,is_active from portal_vendor_access where account_name=$1 and lower(email)=lower($2)`, [ACCOUNT, RECIPIENT]),
      pool.query(`select is_subscribed from customer_email_preferences where account_name=$1 and lower(email) in (lower($2),'*') and notification_type in ('PORTAL_KITTING_STATUS','*')`, [ACCOUNT, RECIPIENT]),
      pool.query(`select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions where source_type='PORTAL_KITTING_REQUEST' and source_id=$1 group by sku`, [CODE]),
      pool.query(`select coalesce(sum(quantity),0)::integer on_hand from inventory_lines where account_name=$1 and sku='628693486149'`, [ACCOUNT]),
      pool.query(`select status,message_id from email_delivery_log where delivery_key=$1`, [DELIVERY_KEY]),
    ]);
    const request = requestResult.rows[0];
    const ledger = Object.fromEntries(ledgerResult.rows.map((row) => [row.sku, Number(row.quantity_delta)]));
    if (requestResult.rowCount !== 1 || request.status !== "COMPLETED" || !request.completed_at
      || String(request.requested_by_email).toLowerCase() !== RECIPIENT
      || request.target_sku !== "628693486149" || Number(request.target_quantity) !== 120
      || ledger["20628693486143"] !== -20 || ledger["628693486149"] !== 120
      || Number(stockResult.rows[0].on_hand) !== 137) throw new Error("KIT-000025 completion verification failed.");
    if (contactResult.rowCount !== 1 || contactResult.rows[0].is_active !== true) throw new Error("The assigned HEALTEA requester is not active.");
    if (preferenceResult.rows.some((row) => row.is_subscribed === false)) throw new Error("The HEALTEA requester or account is opted out.");
    if (existingResult.rows[0]?.status === "SENT") {
      console.log(JSON.stringify({ sent: true, duplicatePrevented: true, providerAccepted: true, bccOnly: true })); return;
    }
    if (!APPLY) {
      console.log(JSON.stringify({ ready: true, sent: false, request: CODE, recipientCount: 1, toSystemAddress: true, ccCount: 0, bccOnly: true })); return;
    }
    if (!process.env.RESEND_API_KEY) throw new Error("The production email provider is not configured.");
    const subject = `Kitting Project Completed - ${CODE}`;
    const text = ["Hello HEALTEA team,", "", `Kitting project ${CODE} has been completed in WMS365.`, "",
      "Component SKU: 20628693486143", "Component quantity consumed: 20 cases",
      "Finished SKU: 628693486149", "Finished quantity produced: 120 cases",
      "Current finished inventory: 137 cases", "Warehouse: Grey Wolf 3PL - Mississauga", "",
      "The finished inventory is available for picking.", "", "Regards,", "WMS365 Support"].join("\n");
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55"><p>Hello HEALTEA team,</p><p>Kitting project <strong>${CODE}</strong> has been completed in WMS365.</p><table style="border-collapse:collapse;width:100%;max-width:680px"><tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Component SKU</td><td style="padding:8px;border:1px solid #d9e2e8">20628693486143</td></tr><tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Component quantity consumed</td><td style="padding:8px;border:1px solid #d9e2e8">20 cases</td></tr><tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished SKU</td><td style="padding:8px;border:1px solid #d9e2e8">628693486149</td></tr><tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished quantity produced</td><td style="padding:8px;border:1px solid #d9e2e8">120 cases</td></tr><tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Current finished inventory</td><td style="padding:8px;border:1px solid #d9e2e8">137 cases</td></tr><tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Warehouse</td><td style="padding:8px;border:1px solid #d9e2e8">Grey Wolf 3PL - Mississauga</td></tr></table><p>The finished inventory is available for picking.</p><p>Regards,<br>WMS365 Support</p></body></html>`;
    const log = await pool.query(`insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,account_name,source_type,source_ref,delivery_key,metadata) values('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,$3,$4,$5,'PORTAL_KITTING_STATUS',$6,$7,$8::jsonb) on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now() returning id`, [JSON.stringify([SYSTEM_TO]), JSON.stringify([RECIPIENT]), SYSTEM_TO, subject, ACCOUNT, CODE, DELIVERY_KEY, JSON.stringify({ targetSku: "628693486149", completedQuantity: 120, availableQuantity: 137, audience: "CUSTOMER_BCC_ONLY", addressingPolicy: "CUSTOMER_BCC_ONLY" })]);
    logId = log.rows[0].id;
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": DELIVERY_KEY }, body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: [SYSTEM_TO], cc: [], bcc: [RECIPIENT], reply_to: SYSTEM_TO, subject, text, html }), signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
    await pool.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1`, [logId, payload.id, "Resend accepted the BCC-only HEALTEA kitting notice."]);
    console.log(JSON.stringify({ sent: true, providerAccepted: true, request: CODE, recipientCount: 1, toSystemAddress: true, ccCount: 0, bccOnly: true }));
  } catch (error) {
    if (logId) await pool.query(`update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`, [logId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  } finally { await pool.end(); }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
