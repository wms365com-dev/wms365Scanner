const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const REQUEST_CODE = "KIT-000019";
const ORIGINAL_MESSAGE_ID = "63487d57-c535-4912-964e-d89ae32edc02";
const NOTICES = [
    {
        key: "KIT-000019-WITHDRAWAL-LANDRY-20260915",
        recipients: ["landry@drinkhealtea.com"],
        subject: "Please delete: WMS365 email sent in error",
        text: [
            "Hello Landry,",
            "",
            "A WMS365 kitting completion email was sent to you in error today and was not intended for your account.",
            "",
            "Please disregard and permanently delete that email, and please do not use or forward its contents. Please reply to confirm deletion when convenient.",
            "",
            "We apologize for the error.",
            "",
            "WMS365 Support"
        ].join("\n")
    }
];

function htmlFromText(text) {
    return `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px">${text
        .split("\n\n")
        .map((paragraph) => `<p>${paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`)
        .join("")}</div>`;
}

async function sendNotice(pool, notice) {
    const existing = await pool.query(
        "select status, message_id from email_delivery_log where delivery_key=$1 limit 1",
        [notice.key]
    );
    if (existing.rows[0]?.status === "SENT") {
        return { recipients: notice.recipients, sent: true, duplicatePrevented: true, messageId: existing.rows[0].message_id };
    }
    const log = await pool.query(
        `insert into email_delivery_log (
            status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
            reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
         ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                   'support@wms365.co',$3,$4,'EMAIL_WITHDRAWAL',$5,$6,$7::jsonb)
         on conflict (delivery_key) do update set status='PENDING', error_message='', failed_at=null, updated_at=now()
         returning id`,
        [JSON.stringify(["support@wms365.co"]), JSON.stringify(notice.recipients), notice.subject,
            ACCOUNT, REQUEST_CODE, notice.key, JSON.stringify({ originalMessageId: ORIGINAL_MESSAGE_ID })]
    );
    const logId = log.rows[0].id;
    try {
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": notice.key
            },
            body: JSON.stringify({
                from: "WMS365 <support@wms365.co>",
                to: ["support@wms365.co"],
                bcc: notice.recipients,
                reply_to: "support@wms365.co",
                subject: notice.subject,
                text: notice.text,
                html: htmlFromText(notice.text)
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await pool.query(
            "update email_delivery_log set status='SENT', message_id=$2, provider_response=$3, sent_at=now(), updated_at=now() where id=$1",
            [logId, payload.id || "", "Resend accepted the withdrawal notice."]
        );
        return { recipients: notice.recipients, sent: true, messageId: payload.id || "" };
    } catch (error) {
        await pool.query(
            "update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1",
            [logId, String(error.message || error).slice(0, 2000)]
        );
        throw error;
    }
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (!process.env.RESEND_API_KEY) throw new Error("The email provider is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        if (!APPLY) {
            console.log(JSON.stringify({ mode: "PREVIEW", requestCode: REQUEST_CODE, originalMessageId: ORIGINAL_MESSAGE_ID, notices: NOTICES }, null, 2));
            return;
        }
        const results = [];
        for (const notice of NOTICES) results.push(await sendNotice(pool, notice));
        await pool.query(
            `insert into activity_log (type,title,details) values ('security',$1,$2)`,
            [
                `Email recipient isolation incident recorded for ${REQUEST_CODE}`,
                `Original message ${ORIGINAL_MESSAGE_ID} included a contact from another company. A private deletion notice was sent only to the unintended recipient. The valid Wellforia email was left unchanged and the Wellforia transaction script was corrected.`
            ]
        );
        const verification = await pool.query(
            `select delivery_key, status, message_id, bcc_addresses, sent_at
             from email_delivery_log where delivery_key=any($1::text[]) order by delivery_key`,
            [NOTICES.map((notice) => notice.key)]
        );
        if (verification.rowCount !== NOTICES.length || verification.rows.some((row) => row.status !== "SENT")) {
            throw new Error("One or more withdrawal notices did not verify as sent.");
        }
        console.log(JSON.stringify({ mode: "APPLIED", results, verification: verification.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
