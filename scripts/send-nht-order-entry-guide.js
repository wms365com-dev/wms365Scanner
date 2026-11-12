const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const ACCOUNT = "NORTH HIMALAYAN TRADERS";
const RECIPIENT = "info@northhimalayantraders.com";
const BCC_RECIPIENT = "prathab@greywolf3pl.com";
const FROM = "WMS365 <support@wms365.co>";
const REPLY_TO = "support@wms365.co";
const SUBJECT = "North Himalayan Traders - WMS365 Order Entry Guide";
const DELIVERY_KEY = "NHT-ORDER-GUIDE-20260909-V1";
const PDF_PATH = path.join(ROOT, "output", "pdf", "North_Himalayan_Traders_WMS365_Order_Entry_Guide.pdf");
const SESSION_FILE = path.join(ROOT, ".tmp", "nht-order-guide-session.json");

const text = [
    "Hello North Himalayan Traders team,",
    "",
    "Attached is your customer-specific WMS365 guide showing how to enter and release outbound orders.",
    "",
    "Portal: https://app.wms365.co/portal.html",
    `Username: ${RECIPIENT}`,
    "",
    "The screenshots show only North Himalayan Traders and the Grey Wolf Edwards Warehouse. No example order was submitted while preparing the guide.",
    "",
    "If you need help signing in, use the Forgot password option on the portal or contact support@wms365.co.",
    "",
    "Regards,",
    "WMS365 Support"
].join("\n");

const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#20313e;line-height:1.55">
<p>Hello North Himalayan Traders team,</p>
<p>Attached is your customer-specific WMS365 guide showing how to enter and release outbound orders.</p>
<p><strong>Portal:</strong> <a href="https://app.wms365.co/portal.html">https://app.wms365.co/portal.html</a><br>
<strong>Username:</strong> ${RECIPIENT}</p>
<p>The screenshots show only <strong>North Himalayan Traders</strong> and the <strong>Grey Wolf Edwards Warehouse</strong>. No example order was submitted while preparing the guide.</p>
<p>If you need help signing in, use the <strong>Forgot password</strong> option on the portal or contact <a href="mailto:support@wms365.co">support@wms365.co</a>.</p>
<p>Regards,<br>WMS365 Support</p>
</body></html>`;

async function sendViaResend(pdfContent) {
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": DELIVERY_KEY
        },
        body: JSON.stringify({
            from: FROM,
            to: [RECIPIENT],
            bcc: [BCC_RECIPIENT],
            reply_to: REPLY_TO,
            subject: SUBJECT,
            text,
            html,
            attachments: [{ filename: path.basename(PDF_PATH), content: pdfContent.toString("base64") }]
        }),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
    return { provider: "RESEND", messageId: payload.id || "", response: "Resend accepted the message." };
}

async function sendViaSmtp(pdfContent) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number.parseInt(process.env.SMTP_PORT || "0", 10),
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ""),
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined
    });
    const info = await transporter.sendMail({
        from: FROM,
        to: RECIPIENT,
        bcc: BCC_RECIPIENT,
        replyTo: REPLY_TO,
        subject: SUBJECT,
        text,
        html,
        attachments: [{ filename: path.basename(PDF_PATH), content: pdfContent, contentType: "application/pdf" }]
    });
    return { provider: "SMTP", messageId: info.messageId || "", response: info.response || "SMTP accepted the message." };
}

async function main() {
    if (!fs.existsSync(PDF_PATH)) throw new Error("The verified PDF guide was not found.");
    if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) throw new Error("No system email provider is configured.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pdfContent = fs.readFileSync(PDF_PATH);
    const pool = new Pool({ connectionString, ssl: false });
    let logId = null;
    try {
        const logResult = await pool.query(
            `insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
             ) values (
                'PENDING',$1,$2,$3::jsonb,'[]'::jsonb,$4::jsonb,$5,$6,$7,'CUSTOMER_GUIDE',$8,$9,$10::jsonb
             ) on conflict (delivery_key) do update set
                status='PENDING', error_message='', failed_at=null, updated_at=now()
             returning id`,
            [
                process.env.RESEND_API_KEY ? "RESEND" : "SMTP",
                FROM,
                JSON.stringify([RECIPIENT]),
                JSON.stringify([BCC_RECIPIENT]),
                REPLY_TO,
                SUBJECT,
                ACCOUNT,
                RECIPIENT,
                DELIVERY_KEY,
                JSON.stringify({ attachment: path.basename(PDF_PATH), customerSpecific: true, guideType: "ORDER_ENTRY" })
            ]
        );
        logId = logResult.rows[0].id;
        const sent = process.env.RESEND_API_KEY
            ? await sendViaResend(pdfContent)
            : await sendViaSmtp(pdfContent);
        await pool.query(
            `update email_delivery_log
             set status='SENT', provider=$2, message_id=$3, provider_response=$4, sent_at=now(), updated_at=now()
             where id=$1`,
            [logId, sent.provider, sent.messageId, sent.response]
        );

        if (fs.existsSync(SESSION_FILE)) {
            const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
            await pool.query("delete from portal_sessions where id = $1 and token_hash = $2", [session.sessionId, session.tokenHash]);
            fs.unlinkSync(SESSION_FILE);
        }

        console.log(JSON.stringify({
            status: "SENT",
            provider: sent.provider,
            messageId: sent.messageId,
            recipient: RECIPIENT,
            bcc: BCC_RECIPIENT,
            attachment: PDF_PATH,
            temporaryPortalSessionRemoved: true
        }, null, 2));
    } catch (error) {
        if (logId) {
            await pool.query(
                `update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1`,
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
