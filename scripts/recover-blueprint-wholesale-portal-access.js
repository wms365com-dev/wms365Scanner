const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { Client } = require("pg");

const ACCOUNT_NAME = "BLUEPRINT WHOLESALE";
const WAREHOUSE_CODE = "GW3PL-MISS";
const API_ORIGIN = "https://app.wms365.co";
const PORTAL_URL = `${API_ORIGIN}/portal.html`;
const SUBJECT = "Your WMS365 Customer Portal Access - Blueprint Wholesale";
const FROM = "WMS365 <support@wms365.co>";
const REPLY_TO = "support@wms365.co";
const RESET_CONFIRMATION = "APPROVED_BLUEPRINT_RECOVERY_2026_09_10";
const USERS = [
    { name: "Keethan Baskaran", email: "keethan@blueprintwholesale.ca" },
    { name: "Archy Viji", email: "archy@blueprintwholesale.ca" }
];

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${derived}`;
}

function createTemporaryPassword() {
    return `WMS365-${crypto.randomBytes(12).toString("base64url")}!`;
}

function printResult(result) {
    console.log("__BLUEPRINT_RESULT_START__");
    console.log(JSON.stringify(result));
    console.log("__BLUEPRINT_RESULT_END__");
}

function buildEmailText(user, password) {
    return [
        `Hello ${user.name.split(" ")[0]},`,
        "",
        "Your WMS365 customer portal access for Blueprint Wholesale is ready and has been tested successfully.",
        "",
        `Login page: ${PORTAL_URL}`,
        `Username: ${user.email}`,
        `Temporary password: ${password}`,
        "",
        "Your account is limited to Blueprint Wholesale and the Grey Wolf 3PL - Mississauga warehouse.",
        "You can review your company's inventory, create sales orders and inbound appointments, upload documents, and track order status.",
        "",
        "Please sign in and change the temporary password under Settings > Password.",
        "Keep this email private. For assistance, contact support@wms365.co.",
        "",
        "Regards,",
        "WMS365 Support"
    ].join("\n");
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildEmailHtml(user, password) {
    return `<!doctype html><html lang="en"><body style="margin:0;background:#f4f7f9;font-family:Arial,sans-serif;color:#172b3a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border:1px solid #d9e2e8;">
<tr><td style="padding:22px 28px;background:#1d5068;color:#fff;"><div style="font-size:13px;font-weight:700;">WMS365</div><div style="font-size:24px;font-weight:700;margin-top:6px;">Customer portal access</div></td></tr>
<tr><td style="padding:26px 28px;line-height:1.55;">
<p style="margin:0 0 16px;">Hello ${escapeHtml(user.name.split(" ")[0])},</p>
<p style="margin:0 0 18px;">Your WMS365 customer portal access for <strong>Blueprint Wholesale</strong> is ready and has been tested successfully.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #d9e2e8;margin-bottom:20px;">
<tr><td style="padding:10px 12px;background:#f7fafb;font-weight:700;border-bottom:1px solid #d9e2e8;">Login page</td><td style="padding:10px 12px;border-bottom:1px solid #d9e2e8;"><a href="${PORTAL_URL}">${PORTAL_URL}</a></td></tr>
<tr><td style="padding:10px 12px;background:#f7fafb;font-weight:700;border-bottom:1px solid #d9e2e8;">Username</td><td style="padding:10px 12px;border-bottom:1px solid #d9e2e8;">${escapeHtml(user.email)}</td></tr>
<tr><td style="padding:10px 12px;background:#f7fafb;font-weight:700;">Temporary password</td><td style="padding:10px 12px;">${escapeHtml(password)}</td></tr>
</table>
<p style="margin:0 0 14px;">Your access is limited to <strong>Blueprint Wholesale</strong> and the <strong>Grey Wolf 3PL - Mississauga</strong> warehouse.</p>
<p style="margin:0 0 14px;">You can review your company's inventory, create sales orders and inbound appointments, upload documents, and track order status.</p>
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
    if (!response.ok) {
        throw new Error(`Portal verification failed (${response.status}): ${payload.error || payload.message || "request failed"}`);
    }
    return payload;
}

async function auditSetup(client) {
    const company = await client.query(
            `select name, legal_name, account_code, contact_name, email, phone, mobile, website,
                    billing_email, address1, address2, city, state, postal_code, country, note, is_active,
                    feature_flags
             from owner_accounts where name=$1`,
            [ACCOUNT_NAME]
        );
    const assignments = await client.query(
            `select f.id, f.code, f.name, c.is_primary, c.allow_inbound, c.allow_outbound,
                    c.allow_storage, c.allow_returns
             from company_fulfillment_locations c
             join fulfillment_locations f on f.id=c.fulfillment_location_id
             where c.account_name=$1`,
            [ACCOUNT_NAME]
        );
    const users = await client.query(
            `select id, email, is_active, portal_permissions
             from portal_vendor_access where account_name=$1 order by email`,
            [ACCOUNT_NAME]
        );
    const locations = await client.query(
            `select code, location_type, is_pickable, account_name, fulfillment_location_id
             from bin_locations where account_name=$1 order by code`,
            [ACCOUNT_NAME]
        );
    const emailLogs = await client.query(
            `select id, status, provider, to_addresses, subject, source_ref, delivery_key,
                    sent_at, failed_at, error_message
             from email_delivery_log
             where account_name=$1 and source_type='PORTAL_ACCESS'
             order by created_at desc limit 10`,
            [ACCOUNT_NAME]
        );
    return {
        company: company.rows,
        assignments: assignments.rows,
        users: users.rows,
        locations: locations.rows,
        emailLogs: emailLogs.rows,
        providers: {
            resendConfigured: Boolean(process.env.RESEND_API_KEY),
            smtpConfigured: Boolean(process.env.SMTP_HOST)
        }
    };
}

async function sendCredentialsViaSmtp(client, resetResult) {
    if (!process.env.SMTP_HOST) throw new Error("The SMTP fallback provider is not configured.");
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number.parseInt(process.env.SMTP_PORT || "0", 10),
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ""),
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
            : undefined
    });
    await transporter.verify();
    const deliveries = [];
    for (const credential of resetResult.credentials) {
        const deliveryKey = `BLUEPRINT-PORTAL-WELCOME-SMTP-20260910:${credential.email}`;
        const logResult = await client.query(
            `insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
             ) values (
                'PENDING','SMTP',$1,$2::jsonb,'[]'::jsonb,'[]'::jsonb,$3,$4,$5,
                'PORTAL_ACCESS',$6,$7,$8::jsonb
             ) on conflict (delivery_key) do update set
                status='PENDING', provider='SMTP', sent_at=null, failed_at=null,
                error_message='', updated_at=now()
             returning id`,
            [
                FROM,
                JSON.stringify([credential.email]),
                REPLY_TO,
                SUBJECT,
                ACCOUNT_NAME,
                credential.email,
                deliveryKey,
                JSON.stringify({
                    tested: true,
                    tenantIsolation: true,
                    warehouseCodes: [WAREHOUSE_CODE],
                    recipientName: credential.name,
                    fallbackAfterProviderQuota: true
                })
            ]
        );
        const logId = logResult.rows[0].id;
        try {
            const info = await transporter.sendMail({
                from: FROM,
                to: credential.email,
                replyTo: REPLY_TO,
                subject: SUBJECT,
                text: buildEmailText(credential, credential.password),
                html: buildEmailHtml(credential, credential.password)
            });
            await client.query(
                `update email_delivery_log
                 set status='SENT', message_id=$2, provider_response=$3,
                     sent_at=now(), failed_at=null, error_message='', updated_at=now()
                 where id=$1`,
                [logId, info.messageId || "", info.response || "SMTP accepted the message."]
            );
            deliveries.push({ email: credential.email, status: "SENT", provider: "SMTP", logId: String(logId) });
        } catch (error) {
            await client.query(
                `update email_delivery_log
                 set status='FAILED', failed_at=now(), error_message=$2, updated_at=now()
                 where id=$1`,
                [logId, String(error.message || error).slice(0, 2000)]
            );
            deliveries.push({ email: credential.email, status: "FAILED", provider: "SMTP", logId: String(logId) });
        }
    }
    return deliveries;
}

function assertExpectedSetup(audit) {
    if (audit.company.length !== 1 || audit.company[0].is_active !== true) {
        throw new Error("Blueprint Wholesale is not an active company.");
    }
    if (audit.company[0]?.feature_flags?.CUSTOMER_PORTAL !== true) {
        throw new Error("Blueprint Wholesale does not have customer portal access enabled.");
    }
    if (audit.assignments.length !== 1 || audit.assignments[0].code !== WAREHOUSE_CODE) {
        throw new Error("Blueprint Wholesale is not assigned exclusively to Grey Wolf Mississauga.");
    }
    const expectedEmails = USERS.map((user) => user.email).sort();
    const actualEmails = audit.users.map((user) => String(user.email).toLowerCase()).sort();
    if (actualEmails.length !== expectedEmails.length || actualEmails.some((email, index) => email !== expectedEmails[index])) {
        throw new Error(`Blueprint Wholesale portal users do not match the expected recipients: ${actualEmails.join(", ") || "none"}.`);
    }
}

async function resetAndVerify(client) {
    if (process.env.CONFIRM_BLUEPRINT_RECOVERY !== RESET_CONFIRMATION) {
        throw new Error(`Set CONFIRM_BLUEPRINT_RECOVERY=${RESET_CONFIRMATION} before resetting credentials.`);
    }
    const audit = await auditSetup(client);
    assertExpectedSetup(audit);
    const credentials = USERS.map((user) => ({ ...user, password: createTemporaryPassword(), accessId: null }));

    await client.query("begin");
    try {
        for (const credential of credentials) {
            const result = await client.query(
                `update portal_vendor_access
                 set password_hash=$2, is_active=true, updated_at=now()
                 where account_name=$1 and lower(email)=lower($3)
                 returning id`,
                [ACCOUNT_NAME, hashPassword(credential.password), credential.email]
            );
            if (result.rowCount !== 1) throw new Error(`Could not reset ${credential.email}.`);
            credential.accessId = result.rows[0].id;
            await client.query("delete from portal_sessions where portal_access_id=$1", [credential.accessId]);
        }
        await client.query(
            `insert into activity_log (type, title, details)
             values ('security',$1,$2)`,
            [
                "Reset and retested Blueprint Wholesale portal credentials",
                `Fresh temporary passwords issued for ${USERS.map((user) => user.email).join(", ")}; all existing portal sessions revoked.`
            ]
        );
        await client.query("commit");
    } catch (error) {
        await client.query("rollback");
        throw error;
    }

    const verificationResults = [];
    for (const credential of credentials) {
        const login = await postJson(`${API_ORIGIN}/api/portal/login`, {
            email: credential.email,
            password: credential.password
        });
        if (!login.response.ok || login.payload?.success !== true) {
            throw new Error(`Live portal login failed for ${credential.email} (${login.response.status}).`);
        }
        const cookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
        if (!cookie) throw new Error(`No live session cookie was returned for ${credential.email}.`);
        const [me, warehouses, orders, inventory] = await Promise.all([
            getJson(`${API_ORIGIN}/api/portal/me`, cookie),
            getJson(`${API_ORIGIN}/api/portal/fulfillment-locations`, cookie),
            getJson(`${API_ORIGIN}/api/portal/orders`, cookie),
            getJson(`${API_ORIGIN}/api/portal/inventory`, cookie)
        ]);
        const accountName = me?.account?.accountName || me?.account?.account_name || login.payload?.account?.accountName || "";
        const visibleWarehouses = Array.isArray(warehouses.locations)
            ? warehouses.locations.map((entry) => String(entry.locationCode || entry.code || ""))
            : [];
        if (accountName !== ACCOUNT_NAME) throw new Error(`Tenant isolation failed for ${credential.email}.`);
        if (visibleWarehouses.length !== 1 || visibleWarehouses[0] !== WAREHOUSE_CODE) {
            throw new Error(`Warehouse isolation failed for ${credential.email}: ${visibleWarehouses.join(", ") || "none"}.`);
        }
        if (!Array.isArray(orders.orders) || orders.orders.length !== 0) {
            throw new Error(`${credential.email} unexpectedly sees order data.`);
        }
        if (!Array.isArray(inventory.inventory) || inventory.inventory.length !== 0) {
            throw new Error(`${credential.email} unexpectedly sees inventory data.`);
        }
        await postJson(`${API_ORIGIN}/api/portal/logout`, {}, cookie);
        verificationResults.push({
            email: credential.email,
            login: true,
            tenant: accountName,
            warehouseCodes: visibleWarehouses,
            orderRows: 0,
            inventoryRows: 0
        });
    }

    return {
        mode: "reset",
        ok: true,
        portalUrl: PORTAL_URL,
        subject: SUBJECT,
        credentials: credentials.map(({ name, email, password }) => ({ name, email, password })),
        verificationResults
    };
}

async function recordOutlookSend(client, email) {
    if (process.env.CONFIRM_BLUEPRINT_RECOVERY !== RESET_CONFIRMATION) {
        throw new Error(`Set CONFIRM_BLUEPRINT_RECOVERY=${RESET_CONFIRMATION} before recording delivery.`);
    }
    const recipient = USERS.find((user) => user.email === String(email || "").toLowerCase());
    if (!recipient) throw new Error("The delivery recipient is not an approved Blueprint Wholesale portal user.");
    const deliveryKey = `BLUEPRINT-PORTAL-WELCOME-OUTLOOK-20260910:${recipient.email}`;
    const result = await client.query(
        `insert into email_delivery_log (
            status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
            reply_to, subject, account_name, source_type, source_ref, delivery_key,
            metadata, sent_at, provider_response
         ) values (
            'SENT','OUTLOOK','Prathab Kandasamy <Prathab@greywolf3pl.com>',$1::jsonb,
            '[]'::jsonb,'[]'::jsonb,'support@wms365.co',$2,$3,'PORTAL_ACCESS',$4,$5,
            $6::jsonb,now(),'Sent through the connected Microsoft Outlook account.'
         ) on conflict (delivery_key) do update set
            status='SENT', provider='OUTLOOK', sent_at=now(), failed_at=null,
            error_message='', provider_response='Sent through the connected Microsoft Outlook account.',
            updated_at=now()
         returning id, status, provider, sent_at`,
        [
            JSON.stringify([recipient.email]),
            SUBJECT,
            ACCOUNT_NAME,
            recipient.email,
            deliveryKey,
            JSON.stringify({
                tested: true,
                tenantIsolation: true,
                warehouseCodes: [WAREHOUSE_CODE],
                recipientName: recipient.name,
                fallbackAfterProviderQuota: true
            })
        ]
    );
    return { mode: "record-sent", ok: true, email: recipient.email, delivery: result.rows[0] };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        if (process.argv.includes("--reset-send-smtp")) {
            const resetResult = await resetAndVerify(client);
            const deliveries = await sendCredentialsViaSmtp(client, resetResult);
            const failed = deliveries.filter((delivery) => delivery.status !== "SENT");
            printResult({
                mode: "reset-send-smtp",
                ok: failed.length === 0,
                verificationResults: resetResult.verificationResults,
                deliveries
            });
            if (failed.length) process.exitCode = 1;
            return;
        }
        if (process.argv.includes("--reset")) {
            printResult(await resetAndVerify(client));
            return;
        }
        const recordArgument = process.argv.find((argument) => argument.startsWith("--record-sent="));
        if (recordArgument) {
            printResult(await recordOutlookSend(client, recordArgument.slice("--record-sent=".length)));
            return;
        }
        const audit = await auditSetup(client);
        assertExpectedSetup(audit);
        printResult({ mode: "audit", ok: true, ...audit });
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    printResult({ ok: false, error: error.message || String(error) });
    process.exitCode = 1;
});
