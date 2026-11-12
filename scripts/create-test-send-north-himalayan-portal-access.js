const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { Client } = require("pg");

const ACCOUNT_NAME = "NORTH HIMALAYAN TRADERS";
const RECIPIENT = "info@northhimalayantraders.com";
const BCC_RECIPIENT = "prathab@greywolf3pl.com";
const PORTAL_URL = "https://app.wms365.co/portal.html";
const API_ORIGIN = "https://app.wms365.co";
const DELIVERY_KEY = "NHT-PORTAL-WELCOME-20260909";
const SUBJECT = "Your WMS365 Customer Portal Access - North Himalayan Traders";
const FROM = "WMS365 <support@wms365.co>";
const REPLY_TO = "support@wms365.co";

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${derived}`;
}

function createTemporaryPassword() {
    return `WMS365-${crypto.randomBytes(12).toString("base64url")}!`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildText(password) {
    return [
        "Hello Atif,",
        "",
        "Your WMS365 customer portal access for North Himalayan Traders is ready and has been tested successfully.",
        "",
        `Login page: ${PORTAL_URL}`,
        `Username: ${RECIPIENT}`,
        `Temporary password: ${password}`,
        "",
        "Your account is limited to North Himalayan Traders and the Grey Wolf Edwards Warehouse.",
        "You can review inventory, create sales orders, submit inbound appointments, upload documents, and track order status.",
        "",
        "Please sign in and change the temporary password under Settings > Password.",
        "Keep this email private. For assistance, contact support@wms365.co.",
        "",
        "Regards,",
        "WMS365 Support"
    ].join("\n");
}

function buildHtml(password) {
    return `<!doctype html>
<html lang="en"><body style="margin:0;background:#f4f7f9;font-family:Arial,sans-serif;color:#172b3a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border:1px solid #d9e2e8;">
<tr><td style="padding:22px 28px;background:#1d5068;color:#fff;"><div style="font-size:13px;font-weight:700;">WMS365</div><div style="font-size:24px;font-weight:700;margin-top:6px;">Customer portal access</div></td></tr>
<tr><td style="padding:26px 28px;line-height:1.55;">
<p style="margin:0 0 16px;">Hello Atif,</p>
<p style="margin:0 0 18px;">Your WMS365 customer portal access for <strong>North Himalayan Traders</strong> is ready and has been tested successfully.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #d9e2e8;margin-bottom:20px;">
<tr><td style="padding:10px 12px;background:#f7fafb;font-weight:700;border-bottom:1px solid #d9e2e8;">Login page</td><td style="padding:10px 12px;border-bottom:1px solid #d9e2e8;"><a href="${PORTAL_URL}">${PORTAL_URL}</a></td></tr>
<tr><td style="padding:10px 12px;background:#f7fafb;font-weight:700;border-bottom:1px solid #d9e2e8;">Username</td><td style="padding:10px 12px;border-bottom:1px solid #d9e2e8;">${escapeHtml(RECIPIENT)}</td></tr>
<tr><td style="padding:10px 12px;background:#f7fafb;font-weight:700;">Temporary password</td><td style="padding:10px 12px;">${escapeHtml(password)}</td></tr>
</table>
<p style="margin:0 0 14px;">Your account is limited to <strong>North Himalayan Traders</strong> and the <strong>Grey Wolf Edwards Warehouse</strong>.</p>
<p style="margin:0 0 14px;">You can review inventory, create sales orders, submit inbound appointments, upload documents, and track order status.</p>
<p style="margin:0;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;">Please sign in and change the temporary password under <strong>Settings &gt; Password</strong>. Keep this email private.</p>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #d9e2e8;color:#5b6b76;font-size:13px;">WMS365 Support<br><a href="mailto:support@wms365.co">support@wms365.co</a></td></tr>
</table></td></tr></table></body></html>`;
}

async function postJson(url, body, cookie = "") {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
}

async function getJson(url, cookie) {
    const response = await fetch(url, {
        headers: { Accept: "application/json", Cookie: cookie },
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Portal verification failed (${response.status}): ${payload.error || payload.message || "request failed"}`);
    return payload;
}

async function sendViaResend(password) {
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
            text: buildText(password),
            html: buildHtml(password)
        }),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
    return { provider: "RESEND", messageId: payload.id || "", providerResponse: "Resend accepted the message." };
}

async function sendViaSmtp(password) {
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
        text: buildText(password),
        html: buildHtml(password)
    });
    return { provider: "SMTP", messageId: info.messageId || "", providerResponse: info.response || "SMTP accepted the message." };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) throw new Error("No system email provider is configured.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const temporaryPassword = createTemporaryPassword();
    let accessId = null;

    try {
        await client.query("begin");
        const ownerResult = await client.query(
            `select name, feature_flags from owner_accounts where name = $1 and is_active = true for update`,
            [ACCOUNT_NAME]
        );
        if (ownerResult.rowCount !== 1 || ownerResult.rows[0]?.feature_flags?.CUSTOMER_PORTAL !== true) {
            throw new Error("North Himalayan Traders is not active for customer portal access.");
        }
        const assignmentResult = await client.query(
            `select f.id, f.code, f.name
             from company_fulfillment_locations c
             join fulfillment_locations f on f.id = c.fulfillment_location_id
             where c.account_name = $1 and f.is_active = true`,
            [ACCOUNT_NAME]
        );
        if (assignmentResult.rowCount !== 1 || assignmentResult.rows[0].code !== "WHS01") {
            throw new Error("Portal access cannot be created until Edwards is the company's only warehouse assignment.");
        }
        const existingResult = await client.query(
            `select id, account_name from portal_vendor_access where lower(email) = lower($1) for update`,
            [RECIPIENT]
        );
        if (existingResult.rowCount && existingResult.rows[0].account_name !== ACCOUNT_NAME) {
            throw new Error(`This email is already assigned to ${existingResult.rows[0].account_name}.`);
        }
        const permissions = {
            "inventory-only": true,
            "order-entry": true,
            "inbound-entry": true,
            "document-access": true,
            billing: true,
            admin: true
        };
        const accessResult = existingResult.rowCount
            ? await client.query(
                `update portal_vendor_access
                 set password_hash=$2, is_active=true, portal_permissions=$3::jsonb, updated_at=now()
                 where id=$1 returning id`,
                [existingResult.rows[0].id, hashPassword(temporaryPassword), JSON.stringify(permissions)]
            )
            : await client.query(
                `insert into portal_vendor_access (account_name, email, password_hash, is_active, portal_permissions)
                 values ($1,$2,$3,true,$4::jsonb) returning id`,
                [ACCOUNT_NAME, RECIPIENT, hashPassword(temporaryPassword), JSON.stringify(permissions)]
            );
        accessId = accessResult.rows[0].id;
        await client.query("delete from portal_sessions where portal_access_id=$1", [accessId]);
        await client.query(
            `insert into activity_log (type, title, details) values ('setup',$1,$2)`,
            [`Created and prepared portal access for ${RECIPIENT}`, `${ACCOUNT_NAME} | Edwards warehouse only | access test required before email.`]
        );
        await client.query("commit");

        const login = await postJson(`${API_ORIGIN}/api/portal/login`, { email: RECIPIENT, password: temporaryPassword });
        if (!login.response.ok || login.payload?.success !== true) {
            throw new Error(`Live portal login test failed (${login.response.status}): ${login.payload.error || login.payload.message || "login rejected"}`);
        }
        const cookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
        if (!cookie) throw new Error("Live portal login test did not return a session cookie.");
        const [me, locations, orders, inventory] = await Promise.all([
            getJson(`${API_ORIGIN}/api/portal/me`, cookie),
            getJson(`${API_ORIGIN}/api/portal/fulfillment-locations`, cookie),
            getJson(`${API_ORIGIN}/api/portal/orders`, cookie),
            getJson(`${API_ORIGIN}/api/portal/inventory`, cookie)
        ]);
        const accountName = me?.account?.accountName || me?.account?.account_name || login.payload?.account?.accountName || "";
        if (accountName !== ACCOUNT_NAME) throw new Error(`Tenant isolation test returned unexpected company ${accountName || "(blank)"}.`);
        const visibleLocations = Array.isArray(locations.locations) ? locations.locations : [];
        const visibleWarehouseCodes = visibleLocations.map((entry) => String(entry.locationCode || entry.code || ""));
        if (visibleWarehouseCodes.length !== 1 || visibleWarehouseCodes[0] !== "WHS01") {
            throw new Error(`Warehouse isolation test returned ${visibleWarehouseCodes.join(", ") || "no warehouses"}.`);
        }
        if (!Array.isArray(orders.orders) || !Array.isArray(inventory.inventory)) {
            throw new Error("Portal order or inventory endpoint did not return the expected customer-scoped data shape.");
        }

        const logResult = await client.query(
            `insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
             ) values (
                'PENDING',$1,$2,$3::jsonb,'[]'::jsonb,$4::jsonb,$5,$6,$7,'PORTAL_ACCESS',$8,$9,$10::jsonb
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
                ACCOUNT_NAME,
                RECIPIENT,
                DELIVERY_KEY,
                JSON.stringify({ tested: true, tenantIsolation: true, warehouseCodes: ["WHS01"] })
            ]
        );
        const logId = logResult.rows[0].id;
        try {
            const sent = process.env.RESEND_API_KEY
                ? await sendViaResend(temporaryPassword)
                : await sendViaSmtp(temporaryPassword);
            await client.query(
                `update email_delivery_log
                 set status='SENT', provider=$2, message_id=$3, provider_response=$4,
                     sent_at=now(), error_message='', updated_at=now()
                 where id=$1`,
                [logId, sent.provider, sent.messageId, sent.providerResponse]
            );
            console.log(JSON.stringify({
                ok: true,
                portalUser: RECIPIENT,
                accountName: ACCOUNT_NAME,
                loginTestPassed: true,
                tenantIsolationPassed: true,
                warehouseIsolationPassed: true,
                visibleWarehouseCodes: ["WHS01"],
                portalEndpointsPassed: ["me", "fulfillment-locations", "orders", "inventory"],
                emailSent: true,
                emailTo: RECIPIENT,
                emailBcc: BCC_RECIPIENT,
                provider: sent.provider,
                messageId: sent.messageId
            }, null, 2));
        } catch (error) {
            await client.query(
                `update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1`,
                [logId, String(error.message || error).slice(0, 2000)]
            );
            throw error;
        }
    } catch (error) {
        if (accessId) {
            await client.query(
                `insert into activity_log (type, title, details) values ('security',$1,$2)`,
                [`Portal access onboarding did not complete for ${RECIPIENT}`, String(error.message || error).slice(0, 1000)]
            ).catch(() => {});
        }
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
