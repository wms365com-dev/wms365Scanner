const { Pool } = require("pg");

const ACCOUNT = "PURE FOODS BY ESTEE";
const CODE = "INB-000212";
const TYPE = "PORTAL_INBOUND_STATUS";
const DELIVERY_KEY = "INBOUND-CLOSED-INB-000212-PURE-FOODS-20261026";
const SYSTEM_TO = "support@wms365.co";

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

async function main() {
    if (!process.env.RESEND_API_KEY) throw new Error("The production email provider is not configured.");
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    let logId = null;
    try {
        const [inbound, lines, receipts, contacts, preferences, existing] = await Promise.all([
            pool.query(
                `select id,status,account_name,reference_number,fulfillment_location_id,received_at,notes
                 from portal_inbounds where inbound_code=$1 and account_name=$2`, [CODE, ACCOUNT]),
            pool.query(
                `select l.sku,l.expected_quantity,l.received_quantity,c.tracking_level,c.units_per_case
                 from portal_inbound_lines l join portal_inbounds i on i.id=l.inbound_id
                 join item_catalog c on c.account_name=i.account_name and c.sku=l.sku
                 where i.inbound_code=$1 and i.account_name=$2 order by l.line_number`, [CODE, ACCOUNT]),
            pool.query(
                `select l.sku,a.quantity,a.allocation_number from portal_inbound_receipt_allocations a
                 join portal_inbound_lines l on l.id=a.line_id join portal_inbounds i on i.id=a.inbound_id
                 where i.inbound_code=$1 and i.account_name=$2 order by l.line_number,a.allocation_number`, [CODE, ACCOUNT]),
            pool.query(
                `select email from portal_vendor_access
                 where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>'' order by id`, [ACCOUNT]),
            pool.query(
                `select lower(email) email,is_subscribed from customer_email_preferences
                 where account_name=$1 and notification_type in ($2,'*')`, [ACCOUNT, TYPE]),
            pool.query("select status,message_id from email_delivery_log where delivery_key=$1", [DELIVERY_KEY]),
        ]);
        if (existing.rows[0]?.status === "SENT") {
            return console.log(JSON.stringify({ sent: true, duplicatePrevented: true, messageId: existing.rows[0].message_id || "" }));
        }
        const header = inbound.rows[0];
        const sku140 = lines.rows.find((row) => row.sku === "140");
        const sku150 = lines.rows.find((row) => row.sku === "150");
        const receipt140 = receipts.rows.filter((row) => row.sku === "140").map((row) => Number(row.quantity));
        const receipt150 = receipts.rows.filter((row) => row.sku === "150").map((row) => Number(row.quantity));
        if (!header || header.status !== "PUTAWAY_COMPLETE" || Number(header.fulfillment_location_id) !== 1
            || Number(sku140?.expected_quantity) !== 1000 || Number(sku140?.received_quantity) !== 256
            || Number(sku150?.expected_quantity) !== 66 || Number(sku150?.received_quantity) !== 66
            || sku150?.tracking_level !== "CASE" || Number(sku150?.units_per_case) !== 12
            || JSON.stringify(receipt140) !== JSON.stringify([97, 159])
            || JSON.stringify(receipt150) !== JSON.stringify([16, 50])) {
            throw new Error("The inbound closure did not pass the pre-email verification.");
        }
        const optedOut = new Set(preferences.rows.filter((row) => row.is_subscribed === false).map((row) => normalizeEmail(row.email)));
        const recipients = [...new Set(contacts.rows.map((row) => normalizeEmail(row.email)).filter(Boolean))]
            .filter((email) => !optedOut.has(email));
        if (!recipients.length) throw new Error("No subscribed Pure Foods portal contacts are available for this notice.");
        const subject = `Inbound Received and Closed - ${CODE} - Pure Foods`;
        const text = [
            "Hello Pure Foods team,",
            "",
            `Inbound ${CODE} has been received and closed in WMS365.`,
            "",
            "Received:",
            "SKU 140: 97 cases + 159 cases = 256 cases",
            "SKU 150: 16 cases + 50 cases = 66 cases",
            "",
            "The remaining 744 cases of SKU 140 were not received and have been closed off from this inbound. Any future balance must be entered on a new inbound.",
            "",
            "The received inventory has been put away and is available in the Mississauga warehouse.",
            "",
            "Regards,",
            "WMS365 Support",
        ].join("\n");
        const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55">
<p>Hello Pure Foods team,</p>
<p>Inbound <strong>${CODE}</strong> has been received and closed in WMS365.</p>
<table style="border-collapse:collapse;width:100%;max-width:640px">
<tr><th style="padding:8px;border:1px solid #d9e2e8;text-align:left">SKU</th><th style="padding:8px;border:1px solid #d9e2e8;text-align:left">Receipt split</th><th style="padding:8px;border:1px solid #d9e2e8;text-align:left">Total received</th></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8">140</td><td style="padding:8px;border:1px solid #d9e2e8">97 + 159 cases</td><td style="padding:8px;border:1px solid #d9e2e8">256 cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8">150</td><td style="padding:8px;border:1px solid #d9e2e8">16 + 50 cases</td><td style="padding:8px;border:1px solid #d9e2e8">66 cases</td></tr>
</table>
<p>The remaining <strong>744 cases of SKU 140</strong> were not received and have been closed off from this inbound. Any future balance must be entered on a new inbound.</p>
<p>The received inventory has been put away and is available in the Mississauga warehouse.</p>
<p>Regards,<br>WMS365 Support</p>
</body></html>`;
        const log = await pool.query(
            `insert into email_delivery_log (
                status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
                account_name,source_type,source_ref,delivery_key,metadata
             ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                       'support@wms365.co',$3,$4,$5,$6,$7,$8::jsonb)
             on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now()
             returning id`,
            [JSON.stringify([SYSTEM_TO]), JSON.stringify(recipients), subject, ACCOUNT, TYPE, CODE, DELIVERY_KEY,
                JSON.stringify({ sku140Received: 256, sku140ClosedVariance: 744, sku150Received: 66,
                    recipientSource: "ACTIVE_ACCOUNT_PORTAL_USERS", addressing: "BCC_ONLY" })]
        );
        logId = log.rows[0].id;
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": DELIVERY_KEY },
            body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: [SYSTEM_TO], cc: [], bcc: recipients,
                reply_to: SYSTEM_TO, subject, text, html }),
            signal: AbortSignal.timeout(30000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await pool.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1`,
            [logId, payload.id || "", "Resend accepted the BCC-only message."]
        );
        console.log(JSON.stringify({ sent: true, providerAccepted: true, messageId: payload.id || "",
            recipientCount: recipients.length, toSystemAddress: true, ccCount: 0, bccOnly: true }));
    } catch (error) {
        if (logId) {
            await pool.query(
                "update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",
                [logId, String(error.message || error).slice(0, 2000)]
            ).catch(() => {});
        }
        throw error;
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
