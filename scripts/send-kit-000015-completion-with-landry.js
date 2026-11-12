const { Pool } = require("pg");

const ACCOUNT = "HEALTEA";
const REQUEST_CODE = "KIT-000015";
const RECIPIENTS = ["commande@thehealtea.com", "landry@drinkhealtea.com"];
const SUBJECT = "Kitting Request Completed - KIT-000015 - 63 Variety Packs";
const DELIVERY_KEY = "KITTING-COMPLETED-KIT-000015-63-LANDRY-20260910";

async function main() {
    if (!process.env.RESEND_API_KEY) throw new Error("The Resend email provider is not configured.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let logId = null;
    try {
        const verification = await pool.query(
            `select k.status, k.target_quantity, i.quantity as finished_stock, b.is_pickable
             from portal_kitting_requests k
             join inventory_lines i on i.account_name=k.account_name and i.sku=k.target_sku and i.location='HEALTEA-BULK'
             join bin_locations b on b.code=i.location
             where k.request_code=$1 and k.account_name=$2`,
            [REQUEST_CODE, ACCOUNT]
        );
        const row = verification.rows[0];
        if (row?.status !== "COMPLETED" || Number(row.target_quantity) !== 63 || Number(row.finished_stock) !== 89 || row.is_pickable !== true) {
            throw new Error("The completed kitting transaction did not pass the pre-email verification.");
        }
        const existing = await pool.query("select status, message_id from email_delivery_log where delivery_key=$1", [DELIVERY_KEY]);
        if (existing.rows[0]?.status === "SENT") {
            console.log(JSON.stringify({ sent: true, duplicatePrevented: true, messageId: existing.rows[0].message_id, bcc: RECIPIENTS }, null, 2));
            return;
        }

        const text = [
            "Hello Healtea team,",
            "",
            `Kitting request ${REQUEST_CODE} has been completed in WMS365.`,
            "",
            "Completed: 63 variety packs",
            "Finished SKU: 628693486408",
            "Pickable location: HEALTEA-BULK",
            "Current finished stock: 89",
            "",
            "Three source cases from each flavour and 63 empty boxes were consumed. Nine loose cans per flavour are recorded in the non-pickable HEALTEA-KIT-WIP location for future kitting use.",
            "",
            "This is an automated WMS365 completion notice.",
            "",
            "Regards,",
            "WMS365 Support"
        ].join("\n");
        const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55">
<p>Hello Healtea team,</p>
<p>Kitting request <strong>${REQUEST_CODE}</strong> has been completed in WMS365.</p>
<table style="border-collapse:collapse;width:100%;max-width:620px">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Completed</td><td style="padding:8px;border:1px solid #d9e2e8">63 variety packs</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished SKU</td><td style="padding:8px;border:1px solid #d9e2e8">628693486408</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Pickable location</td><td style="padding:8px;border:1px solid #d9e2e8">HEALTEA-BULK</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Current finished stock</td><td style="padding:8px;border:1px solid #d9e2e8">89</td></tr>
</table>
<p>Three source cases from each flavour and 63 empty boxes were consumed. Nine loose cans per flavour are recorded in the non-pickable <strong>HEALTEA-KIT-WIP</strong> location for future kitting use.</p>
<p style="color:#657783">This is an automated WMS365 completion notice.</p>
<p>Regards,<br>WMS365 Support</p>
</body></html>`;

        const logResult = await pool.query(
            `insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
             ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                       'support@wms365.co',$3,$4,'PORTAL_KITTING_REQUEST',$5,$6,$7::jsonb)
             on conflict (delivery_key) do update set status='PENDING', error_message='', failed_at=null, updated_at=now()
             returning id`,
            [JSON.stringify(["support@wms365.co"]), JSON.stringify(RECIPIENTS), SUBJECT, ACCOUNT, REQUEST_CODE, DELIVERY_KEY,
                JSON.stringify({ completedQuantity: 63, finishedStock: 89, includesLandry: true })]
        );
        logId = logResult.rows[0].id;
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": DELIVERY_KEY
            },
            body: JSON.stringify({
                from: "WMS365 <support@wms365.co>",
                to: ["support@wms365.co"],
                bcc: RECIPIENTS,
                reply_to: "support@wms365.co",
                subject: SUBJECT,
                text,
                html
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await pool.query(
            "update email_delivery_log set status='SENT', message_id=$2, provider_response=$3, sent_at=now(), updated_at=now() where id=$1",
            [logId, payload.id || "", "Resend accepted the message."]
        );
        console.log(JSON.stringify({ sent: true, provider: "RESEND", messageId: payload.id || "", bcc: RECIPIENTS }, null, 2));
    } catch (error) {
        if (logId) {
            await pool.query(
                "update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1",
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
    process.exit(1);
});
