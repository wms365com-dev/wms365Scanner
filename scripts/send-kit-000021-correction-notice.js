const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const REQUEST_CODE = "KIT-000021";
const DELIVERY_KEY = "KITTING-CORRECTION-KIT-000021-WELLFORIA-12PK-4PERCASE";
const RECIPIENTS = ["usman.tahir@wellforia.com", "yudhishter@wellforia.com"];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (!process.env.RESEND_API_KEY) throw new Error("The email provider is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const requestResult = await pool.query(
            `select request_code,status,source_sku,source_quantity,target_sku,target_quantity,notes
             from portal_kitting_requests where account_name=$1 and request_code=$2`,
            [ACCOUNT, REQUEST_CODE]
        );
        const request = requestResult.rows[0];
        if (!request || request.status !== "SUBMITTED" || request.source_sku !== "WW-12PK"
            || Number(request.source_quantity) !== 6 || request.target_sku !== "WW-12PK-EA"
            || Number(request.target_quantity) !== 24) throw new Error("The corrected work order could not be verified; email was not sent.");
        const existing = await pool.query("select status,message_id from email_delivery_log where delivery_key=$1 limit 1", [DELIVERY_KEY]);
        if (existing.rows[0]?.status === "SENT") {
            const result = { sent: true, duplicatePrevented: true, messageId: existing.rows[0].message_id, requestCode: REQUEST_CODE };
            console.log(JSON.stringify(result, null, 2));
            return result;
        }
        const subject = `Work Order Corrected - ${REQUEST_CODE} - Wellforia`;
        const text = [
            `Work order ${REQUEST_CODE} has been corrected for Wellforia.`, "",
            "Source: 6 master cases of WW-12PK",
            "Case pack: 4 consumer 12-packs per master case",
            "Expected output: 24 individually pickable WW-12PK-EA",
            "Current requirement: 22 packs",
            "Remaining after the current requirement: 2 packs returned to pickable each inventory", "",
            "The work order remains submitted and must be completed through the normal warehouse workflow before the related orders are released."
        ].join("\n");
        const html = `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px">
<h2 style="color:#1d5068">Work order corrected</h2>
<p><strong>${REQUEST_CODE}</strong> has been corrected for <strong>Wellforia</strong>.</p>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Source</td><td style="padding:8px;border:1px solid #d9e2e8">6 master cases of WW-12PK</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Case pack</td><td style="padding:8px;border:1px solid #d9e2e8">4 consumer 12-packs per master case</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Expected output</td><td style="padding:8px;border:1px solid #d9e2e8">24 individually pickable WW-12PK-EA</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Current requirement</td><td style="padding:8px;border:1px solid #d9e2e8">22 packs, leaving 2 packs in pickable each inventory</td></tr>
</table>
<p>The work order remains <strong>Submitted</strong> and must be completed through the normal warehouse workflow before the related orders are released.</p>
<p style="color:#657783">This is a WMS365 work-order correction notice.</p></div>`;
        const logResult = await pool.query(
            `insert into email_delivery_log (
                status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
                account_name,source_type,source_ref,delivery_key,metadata
             ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                       'support@wms365.co',$3,$4,'PORTAL_KITTING_STATUS',$5,$6,$7::jsonb)
             on conflict (delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now()
             returning id`,
            [JSON.stringify(["support@wms365.co"]), JSON.stringify(RECIPIENTS), subject, ACCOUNT,
                REQUEST_CODE, DELIVERY_KEY, JSON.stringify({ sourceCases: 6, packsPerCase: 4, targetPacks: 24 })]
        );
        const logId = logResult.rows[0].id;
        try {
            const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
                method: "POST",
                headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": DELIVERY_KEY },
                body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: ["support@wms365.co"], bcc: RECIPIENTS,
                    reply_to: "support@wms365.co", subject, text, html }),
                signal: AbortSignal.timeout(30000)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
            await pool.query(
                "update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1",
                [logId, payload.id || "", "Resend accepted the message."]
            );
            const result = { sent: true, duplicatePrevented: false, messageId: payload.id || "", requestCode: REQUEST_CODE, recipientCount: RECIPIENTS.length };
            console.log(JSON.stringify(result, null, 2));
            return result;
        } catch (error) {
            await pool.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1", [logId, String(error.message || error).slice(0, 2000)]);
            throw error;
        }
    } finally {
        await pool.end();
    }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
