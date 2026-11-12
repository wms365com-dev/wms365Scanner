"use strict";

const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const ACCOUNT_ID = "794";
const INBOUND = "107019";
const CONTAINER = "BEAU6285382";
const RECIPIENT = "usman.tahir@wellforia.com";
const TYPE = "PORTAL_INBOUND";
const DELIVERY_KEY = "WELLFORIA-INBOUND-107019-RECEIVED-20261005";
const SYSTEM_TO = "support@wms365.co";

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  let logId = null;
  try {
    const [accountResult, contactResult, inboundResult, lineResult, preferenceResult, existingResult] = await Promise.all([
      pool.query("select id, is_active from owner_accounts where name = $1", [ACCOUNT]),
      pool.query(
        `select email, is_active from portal_vendor_access
          where account_name = $1 and lower(email) = lower($2)`,
        [ACCOUNT, RECIPIENT]
      ),
      pool.query(
        `select i.id, i.inbound_code, i.status, i.reference_number,
                i.received_at, fl.code warehouse_code
           from portal_inbounds i
           join fulfillment_locations fl on fl.id = i.fulfillment_location_id
          where i.account_name = $1 and i.inbound_code = $2`,
        [ACCOUNT, INBOUND]
      ),
      pool.query(
        `select l.sku, l.expected_quantity, l.received_quantity, l.received_location
           from portal_inbound_lines l
           join portal_inbounds i on i.id = l.inbound_id
          where i.account_name = $1 and i.inbound_code = $2
          order by l.line_number`,
        [ACCOUNT, INBOUND]
      ),
      pool.query(
        `select email, notification_type, is_subscribed
           from customer_email_preferences
          where account_name = $1
            and lower(email) in (lower($2), '*')
            and notification_type in ($3, '*')`,
        [ACCOUNT, RECIPIENT, TYPE]
      ),
      pool.query(
        "select status, message_id from email_delivery_log where delivery_key = $1",
        [DELIVERY_KEY]
      ),
    ]);

    if (accountResult.rowCount !== 1 || String(accountResult.rows[0].id) !== ACCOUNT_ID
      || accountResult.rows[0].is_active !== true) {
      throw new Error("Exact active Wellforia account verification failed.");
    }
    if (contactResult.rowCount !== 1 || contactResult.rows[0].is_active !== true) {
      throw new Error("Usman is not an active contact assigned to Wellforia.");
    }
    if (preferenceResult.rows.some((row) => row.is_subscribed === false)) {
      throw new Error("The Wellforia contact or account is opted out of inbound notices.");
    }
    const inbound = inboundResult.rows[0];
    if (inboundResult.rowCount !== 1 || inbound.status !== "PUTAWAY_COMPLETE"
      || inbound.reference_number !== CONTAINER || inbound.warehouse_code !== "GW3PL-MISS"
      || new Date(inbound.received_at).toISOString().slice(0, 10) !== "2026-10-05") {
      throw new Error("Inbound 107019 did not pass the pre-email receipt verification.");
    }
    const expectedLines = new Map([["WHOOPSIE-SMPL", 60], ["WW-12PK", 750]]);
    if (lineResult.rowCount !== expectedLines.size || lineResult.rows.some((line) =>
      expectedLines.get(line.sku) !== Number(line.received_quantity)
      || Number(line.expected_quantity) !== Number(line.received_quantity)
      || line.received_location !== "GW3PL-MISS-WELLFORIA-BULK")) {
      throw new Error("Inbound 107019 line verification failed.");
    }
    if (existingResult.rows[0]?.status === "SENT") {
      console.log(JSON.stringify({ sent: true, duplicatePrevented: true,
        providerAccepted: true, bccOnly: true, recipientCount: 1 }));
      return;
    }

    const subject = `Inbound Received - ${INBOUND} - Container ${CONTAINER}`;
    const text = [
      "Hello Usman,",
      "",
      `Inbound ${INBOUND} for container ${CONTAINER} has been received and put away at Grey Wolf 3PL - Mississauga.`,
      "",
      "Received date: October 5, 2026",
      "Pallets: 45",
      "WHOOPSIE-SMPL - WHOOPSIE SAMPLES - 20CT: 60 cases",
      "WW-12PK - WHOOPSIE WIPES 12 PACK: 750 cases",
      "",
      "The inventory is available for picking.",
      "",
      "Regards,",
      "WMS365 Support",
    ].join("\n");
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55">
<p>Hello Usman,</p>
<p>Inbound <strong>${INBOUND}</strong> for container <strong>${CONTAINER}</strong> has been received and put away at Grey Wolf 3PL - Mississauga.</p>
<table style="border-collapse:collapse;width:100%;max-width:680px">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Received date</td><td style="padding:8px;border:1px solid #d9e2e8">October 5, 2026</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Pallets</td><td style="padding:8px;border:1px solid #d9e2e8">45</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">WHOOPSIE-SMPL</td><td style="padding:8px;border:1px solid #d9e2e8">WHOOPSIE SAMPLES - 20CT: 60 cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">WW-12PK</td><td style="padding:8px;border:1px solid #d9e2e8">WHOOPSIE WIPES 12 PACK: 750 cases</td></tr>
</table>
<p>The inventory is available for picking.</p>
<p>Regards,<br>WMS365 Support</p>
</body></html>`;

    if (!APPLY) {
      console.log(JSON.stringify({ ready: true, sent: false, inbound: INBOUND,
        recipientCount: 1, toSystemAddress: true, ccCount: 0, bccOnly: true }));
      return;
    }
    if (!process.env.RESEND_API_KEY) throw new Error("The production email provider is not configured.");

    const log = await pool.query(
      `insert into email_delivery_log (
         status, provider, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to,
         subject, account_name, source_type, source_ref, delivery_key, metadata
       ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                 $3,$4,$5,$6,$7,$8,$9::jsonb)
       on conflict(delivery_key) do update
         set status='PENDING', error_message='', failed_at=null, updated_at=now()
       returning id`,
      [JSON.stringify([SYSTEM_TO]), JSON.stringify([RECIPIENT]), SYSTEM_TO, subject,
        ACCOUNT, TYPE, INBOUND, DELIVERY_KEY,
        JSON.stringify({ container: CONTAINER, receivedDate: "2026-10-05", palletCount: 45,
          audience: "CUSTOMER_BCC_ONLY", addressingPolicy: "CUSTOMER_BCC_ONLY" })]
    );
    logId = log.rows[0].id;
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": DELIVERY_KEY,
      },
      body: JSON.stringify({
        from: "WMS365 <support@wms365.co>",
        to: [SYSTEM_TO],
        cc: [],
        bcc: [RECIPIENT],
        reply_to: SYSTEM_TO,
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
    }
    await pool.query(
      `update email_delivery_log
          set status='SENT', message_id=$2, provider_response=$3, sent_at=now(), updated_at=now()
        where id=$1`,
      [logId, payload.id, "Resend accepted the BCC-only Wellforia inbound notice."]
    );
    console.log(JSON.stringify({ sent: true, providerAccepted: true, recipientCount: 1,
      toSystemAddress: true, ccCount: 0, bccOnly: true }));
  } catch (error) {
    if (logId) {
      await pool.query(
        `update email_delivery_log set status='FAILED', error_message=$2,
                failed_at=now(), updated_at=now() where id=$1`,
        [logId, String(error.message || error).slice(0, 2000)]
      ).catch(() => {});
    }
    throw error;
  } finally {
    await pool.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
