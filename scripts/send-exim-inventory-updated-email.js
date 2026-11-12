const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const ACCOUNT_NAME = "EXIM WORLD CONNECT INC.";
const RECIPIENT = "mynurrashid@eximworldconnect.com";
const DELIVERY_KEY = "EXIM-TIGER-INVENTORY-GUIDE-20260902";
const SUBJECT = "EXIM WMS365 Inventory Updated - TIGER";
const FROM = "WMS365 <support@wms365.co>";
const REPLY_TO = "support@wms365.co";
const GUIDE_PATH = path.resolve(
    __dirname,
    "../outputs/exim-outbound-order-guide/EXIM_WMS365_Outbound_Order_Guide.pdf"
);

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildText() {
    return [
        "Hello Mynur,",
        "",
        "Your EXIM inventory has been updated in WMS365 and is available for outbound orders.",
        "",
        "SKU: TIGER",
        "Description: Royal Tiger 250 ml",
        "Available inventory: 1,220 cases",
        "Pallets received: 13",
        "Warehouse: Grey Wolf 3PL - Mississauga",
        "",
        "Please use the WMS365 customer portal to submit outbound orders going forward so inventory and order status remain current:",
        "https://app.wms365.co/portal.html",
        "",
        "The attached EXIM-specific guide shows how to view live inventory and enter an outbound order.",
        "",
        "Regards,",
        "WMS365 Support",
        "support@wms365.co"
    ].join("\n");
}

function buildHtml() {
    const rows = [
        ["SKU", "TIGER"],
        ["Description", "Royal Tiger 250 ml"],
        ["Available inventory", "1,220 cases"],
        ["Pallets received", "13"],
        ["Warehouse", "Grey Wolf 3PL - Mississauga"]
    ];
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f7f9;font-family:Arial,sans-serif;color:#172b3a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:100%;max-width:620px;background:#ffffff;border:1px solid #d9e2e8;">
        <tr><td style="padding:22px 28px;background:#1d5068;color:#ffffff;">
          <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">WMS365</div>
          <div style="font-size:24px;font-weight:700;margin-top:6px;">Inventory updated</div>
        </td></tr>
        <tr><td style="padding:26px 28px;">
          <p style="margin:0 0 16px;">Hello Mynur,</p>
          <p style="margin:0 0 20px;line-height:1.55;">Your EXIM inventory has been updated in WMS365 and is available for outbound orders.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #d9e2e8;">
            ${rows.map(([label, value]) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #d9e2e8;background:#f7fafb;font-weight:700;width:42%;">${escapeHtml(label)}</td><td style="padding:10px 12px;border-bottom:1px solid #d9e2e8;">${escapeHtml(value)}</td></tr>`).join("")}
          </table>
          <p style="margin:22px 0 16px;line-height:1.55;">Please use the WMS365 customer portal to submit outbound orders going forward so inventory and order status remain current.</p>
          <p style="margin:0 0 22px;"><a href="https://app.wms365.co/portal.html" style="display:inline-block;background:#1d5068;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;">Open WMS365 Customer Portal</a></p>
          <p style="margin:0;line-height:1.55;">The attached EXIM-specific guide shows how to view live inventory and enter an outbound order.</p>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #d9e2e8;color:#5b6b76;font-size:13px;line-height:1.5;">WMS365 Support<br><a href="mailto:support@wms365.co" style="color:#1d5068;">support@wms365.co</a></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function claimDelivery(pool) {
    const values = [
        "PENDING",
        process.env.RESEND_API_KEY ? "RESEND" : "SMTP",
        FROM,
        JSON.stringify([RECIPIENT]),
        SUBJECT,
        ACCOUNT_NAME,
        "CUSTOMER_INVENTORY_GUIDE",
        "TIGER",
        DELIVERY_KEY,
        JSON.stringify({ sku: "TIGER", quantity: 1220, palletCount: 13, warehouseCode: "GW3PL-MISS" })
    ];
    const inserted = await pool.query(
        `insert into email_delivery_log (
            status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
            reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
        ) values ($1,$2,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,$3,$5,$6,$7,$8,$9,$10::jsonb)
        on conflict (delivery_key) do nothing
        returning id, status`,
        values
    );
    if (inserted.rowCount) return inserted.rows[0].id;

    const existing = await pool.query(
        "select id, status from email_delivery_log where delivery_key=$1 limit 1",
        [DELIVERY_KEY]
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Unable to reserve the email delivery record.");
    if (row.status !== "FAILED") {
        throw new Error(`Email not sent again: delivery record is already ${row.status}.`);
    }
    await pool.query(
        `update email_delivery_log
         set status='PENDING', error_message='', failed_at=null, updated_at=now()
         where id=$1`,
        [row.id]
    );
    return row.id;
}

async function sendViaResend(mail) {
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
            reply_to: REPLY_TO,
            subject: SUBJECT,
            text: mail.text,
            html: mail.html,
            attachments: [{
                filename: "EXIM_WMS365_Outbound_Order_Guide.pdf",
                content: mail.guide.toString("base64")
            }]
        }),
        signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `Resend failed with HTTP ${response.status}`);
    return { provider: "RESEND", messageId: data.id || "", response: data.id ? `Resend accepted email ${data.id}` : "Resend accepted email" };
}

async function sendViaSmtp(mail) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number.parseInt(process.env.SMTP_PORT || "0", 10),
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ""),
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined
    });
    const info = await transporter.sendMail({
        from: FROM,
        to: RECIPIENT,
        replyTo: REPLY_TO,
        subject: SUBJECT,
        text: mail.text,
        html: mail.html,
        attachments: [{
            filename: "EXIM_WMS365_Outbound_Order_Guide.pdf",
            content: mail.guide,
            contentType: "application/pdf"
        }]
    });
    return { provider: "SMTP", messageId: info.messageId || "", response: info.response || "SMTP accepted email" };
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not available.");
    if (!fs.existsSync(GUIDE_PATH)) throw new Error(`EXIM guide not found: ${GUIDE_PATH}`);
    if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) throw new Error("No system email provider is configured.");

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let logId;
    try {
        logId = await claimDelivery(pool);
        const mail = { text: buildText(), html: buildHtml(), guide: fs.readFileSync(GUIDE_PATH) };
        const result = process.env.RESEND_API_KEY ? await sendViaResend(mail) : await sendViaSmtp(mail);
        await pool.query(
            `update email_delivery_log
             set status='SENT', provider=$2, message_id=$3, provider_response=$4,
                 error_message='', sent_at=now(), updated_at=now()
             where id=$1`,
            [logId, result.provider, result.messageId, result.response]
        );
        const verification = await pool.query(
            `select status, provider, to_addresses, subject, message_id, sent_at
             from email_delivery_log where id=$1`,
            [logId]
        );
        console.log(JSON.stringify({ sent: true, ...verification.rows[0] }, null, 2));
    } catch (error) {
        if (logId) {
            await pool.query(
                `update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1`,
                [logId, String(error?.message || error).slice(0, 2000)]
            ).catch(() => {});
        }
        throw error;
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
