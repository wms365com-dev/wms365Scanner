const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const APPLY_CONFIRMATION = "APPROVED_BLUEPRINT_WHOLESALE_2026_09_10";
const ACCOUNT_NAME = "BLUEPRINT WHOLESALE";
const LEGAL_NAME = "Blueprint Wholesale";
const ACCOUNT_CODE = "BPW";
const WAREHOUSE_CODE = "GW3PL-MISS";
const PORTAL_URL = "https://app.wms365.co/portal.html";
const API_ORIGIN = "https://app.wms365.co";
const FROM = "WMS365 <support@wms365.co>";
const REPLY_TO = "support@wms365.co";
const USERS = [
    { name: "Keethan Baskaran", email: "keethan@blueprintwholesale.ca", admin: true },
    { name: "Archy Viji", email: "archy@blueprintwholesale.ca", admin: true }
];
const LOCATIONS = [
    { code: "GW3PL-MISS-BPW-A01", type: "STORAGE", pickable: true, note: "Blueprint Wholesale pickable storage." },
    { code: "GW3PL-MISS-BPW-REC", type: "RECEIVING_STAGE", pickable: false, note: "Blueprint Wholesale receiving stage; putaway is required before allocation." },
    { code: "GW3PL-MISS-BPW-INV", type: "QA_HOLD", pickable: false, note: "Blueprint Wholesale investigation hold; unavailable for order allocation." },
    { code: "GW3PL-MISS-BPW-DMG", type: "DAMAGED", pickable: false, note: "Blueprint Wholesale damaged stock; unavailable for order allocation." }
];

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

function buildText(user, password) {
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

function buildHtml(user, password) {
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
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
}

async function getJson(url, cookie) {
    const response = await fetch(url, { headers: { Accept: "application/json", Cookie: cookie }, signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Portal verification failed (${response.status}): ${payload.error || payload.message || "request failed"}`);
    return payload;
}

async function sendEmail(user, password) {
    const subject = "Your WMS365 Customer Portal Access - Blueprint Wholesale";
    const deliveryKey = `BLUEPRINT-PORTAL-WELCOME-20260910:${user.email}`;
    if (process.env.RESEND_API_KEY) {
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": deliveryKey },
            body: JSON.stringify({
                from: FROM,
                to: [user.email],
                reply_to: REPLY_TO,
                subject,
                text: buildText(user, password),
                html: buildHtml(user, password)
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        return { provider: "RESEND", messageId: payload.id || "", providerResponse: "Resend accepted the message.", subject, deliveryKey };
    }
    if (!process.env.SMTP_HOST) throw new Error("No system email provider is configured.");
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number.parseInt(process.env.SMTP_PORT || "0", 10),
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ""),
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined
    });
    const info = await transporter.sendMail({
        from: FROM,
        to: user.email,
        replyTo: REPLY_TO,
        subject,
        text: buildText(user, password),
        html: buildHtml(user, password)
    });
    return { provider: "SMTP", messageId: info.messageId || "", providerResponse: info.response || "SMTP accepted the message.", subject, deliveryKey };
}

async function getPreflight(client) {
    const companyResult = await client.query(
            `select name, legal_name, account_code, email, billing_email, portal_login_email
             from owner_accounts
             where upper(name) = $1 or upper(legal_name) = upper($2)
                or lower(email) = any($3::text[]) or lower(billing_email) = any($3::text[])
                or lower(portal_login_email) = any($3::text[])`,
            [ACCOUNT_NAME, LEGAL_NAME, USERS.map((user) => user.email)]
        );
    const userResult = await client.query(
            `select email, account_name, is_active from portal_vendor_access where lower(email) = any($1::text[])`,
            [USERS.map((user) => user.email)]
        );
    const warehouseResult = await client.query(
            `select id, code, name, address1, city, state, postal_code, country, is_active
             from fulfillment_locations where code = $1`,
            [WAREHOUSE_CODE]
        );
    const codeResult = await client.query(`select name, account_code from owner_accounts where account_code = $1`, [ACCOUNT_CODE]);
    const locationConflictResult = await client.query(
            `select code, account_name, fulfillment_location_id
             from bin_locations where code = any($1::text[])`,
            [LOCATIONS.map((location) => location.code)]
        );
    return {
        companies: companyResult.rows,
        users: userResult.rows,
        warehouse: warehouseResult.rows[0] || null,
        accountCodeOwners: codeResult.rows,
        locationConflicts: locationConflictResult.rows
    };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    if (APPLY && process.env.CONFIRM_BLUEPRINT_WHOLESALE !== APPLY_CONFIRMATION) {
        throw new Error(`Set CONFIRM_BLUEPRINT_WHOLESALE=${APPLY_CONFIRMATION} before using --apply.`);
    }
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const preflight = await getPreflight(client);

    if (!preflight.warehouse || preflight.warehouse.is_active !== true || !/GREY WOLF/i.test(preflight.warehouse.name || "")) {
        throw new Error("The active Grey Wolf Mississauga warehouse could not be verified.");
    }
    if (preflight.companies.length || preflight.users.length || preflight.accountCodeOwners.length || preflight.locationConflicts.length) {
        throw new Error(`Blueprint onboarding conflicts with existing records: ${JSON.stringify(preflight)}.`);
    }
    if (!APPLY) {
        console.log(JSON.stringify({ mode: "audit", ok: true, accountName: ACCOUNT_NAME, users: USERS, warehouse: preflight.warehouse, locations: LOCATIONS }, null, 2));
        await client.end();
        return;
    }

    const credentials = USERS.map((user) => ({ ...user, password: createTemporaryPassword(), accessId: null }));
    const featureFlags = {
        CUSTOMER_PORTAL: true,
        ORDER_ENTRY: true,
        INBOUND_NOTICES: true,
        BILLING: true,
        STORE_INTEGRATIONS: false,
        SHOPIFY_INTEGRATION: false,
        SFTP_INTEGRATION: false
    };

    await client.query("begin");
    try {
        await client.query(
            `insert into owner_accounts (
                name, legal_name, account_code, contact_name, contact_title,
                email, phone, mobile, website, billing_email, ap_email, portal_login_email,
                address1, address2, city, state, postal_code, country, note, is_active,
                feature_flags, feature_flags_updated_at, feature_flags_updated_by,
                wms_access_mode, wms_subscription_status, wms_subscription_note
             ) values (
                $1,$2,$3,$4,'Billing Contact',$5,$6,$7,$8,$5,$5,$5,
                '1501 Howard Ave','#107','Windsor','ON','N8X 3T5','Canada',$9,true,
                $10::jsonb,now(),'WMS365 onboarding','AUTO','ACTIVE',$11
             )`,
            [
                ACCOUNT_NAME, LEGAL_NAME, ACCOUNT_CODE, "Keethan Baskaran", "keethan@blueprintwholesale.ca",
                "+1 226-799-1177", "+1 647-761-9450", "https://blueprintwholesale.ca/",
                "Currency: CAD. Zoho customer portal: enabled. Additional contact: Archy Viji <archy@blueprintwholesale.ca>.",
                JSON.stringify(featureFlags),
                "Customer assigned exclusively to Grey Wolf 3PL - Mississauga."
            ]
        );
        await client.query(
            `insert into company_fulfillment_locations (
                account_name, fulfillment_location_id, is_primary,
                allow_inbound, allow_outbound, allow_storage, allow_returns, note
             ) values ($1,$2,true,true,true,true,true,$3)`,
            [ACCOUNT_NAME, preflight.warehouse.id, "Exclusive company assignment to Grey Wolf 3PL - Mississauga."]
        );
        for (const location of LOCATIONS) {
            await client.query(
                `insert into bin_locations (
                    code, note, location_type, is_pickable, equipment_type,
                    account_name, fulfillment_location_id
                 ) values ($1,$2,$3,$4,'',$5,$6)`,
                [location.code, location.note, location.type, location.pickable, ACCOUNT_NAME, preflight.warehouse.id]
            );
        }
        const permissions = {
            "inventory-only": true,
            "order-entry": true,
            "inbound-entry": true,
            "document-access": true,
            billing: true,
            admin: true
        };
        for (const credential of credentials) {
            const result = await client.query(
                `insert into portal_vendor_access (account_name, email, password_hash, is_active, portal_permissions)
                 values ($1,$2,$3,true,$4::jsonb) returning id`,
                [ACCOUNT_NAME, credential.email, hashPassword(credential.password), JSON.stringify(permissions)]
            );
            credential.accessId = result.rows[0].id;
        }
        await client.query(
            `insert into activity_log (type, title, details) values ('setup',$1,$2)`,
            [`Created customer ${ACCOUNT_NAME}`, `Assigned only to ${preflight.warehouse.name} (${WAREHOUSE_CODE}); created ${LOCATIONS.length} scoped locations and ${USERS.length} portal accounts.`]
        );
        await client.query("commit");
    } catch (error) {
        await client.query("rollback");
        throw error;
    }

    const verificationResults = [];
    for (const credential of credentials) {
        const login = await postJson(`${API_ORIGIN}/api/portal/login`, { email: credential.email, password: credential.password });
        if (!login.response.ok || login.payload?.success !== true) {
            throw new Error(`Live portal login test failed for ${credential.email} (${login.response.status}): ${login.payload.error || login.payload.message || "login rejected"}`);
        }
        const cookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
        if (!cookie) throw new Error(`Live portal login test did not return a session cookie for ${credential.email}.`);
        const [me, locations, orders, inventory] = await Promise.all([
            getJson(`${API_ORIGIN}/api/portal/me`, cookie),
            getJson(`${API_ORIGIN}/api/portal/fulfillment-locations`, cookie),
            getJson(`${API_ORIGIN}/api/portal/orders`, cookie),
            getJson(`${API_ORIGIN}/api/portal/inventory`, cookie)
        ]);
        const accountName = me?.account?.accountName || me?.account?.account_name || login.payload?.account?.accountName || "";
        if (accountName !== ACCOUNT_NAME) throw new Error(`Tenant isolation test returned ${accountName || "(blank)"} for ${credential.email}.`);
        const visibleLocations = Array.isArray(locations.locations) ? locations.locations : [];
        const visibleWarehouseCodes = visibleLocations.map((entry) => String(entry.locationCode || entry.code || ""));
        if (visibleWarehouseCodes.length !== 1 || visibleWarehouseCodes[0] !== WAREHOUSE_CODE) {
            throw new Error(`Warehouse isolation test returned ${visibleWarehouseCodes.join(", ") || "no warehouses"} for ${credential.email}.`);
        }
        if (!Array.isArray(orders.orders) || orders.orders.length !== 0) throw new Error(`New Blueprint account unexpectedly sees ${orders.orders?.length ?? "invalid"} orders.`);
        if (!Array.isArray(inventory.inventory) || inventory.inventory.length !== 0) throw new Error(`New Blueprint account unexpectedly sees ${inventory.inventory?.length ?? "invalid"} inventory rows.`);
        await postJson(`${API_ORIGIN}/api/portal/logout`, {}, cookie);
        verificationResults.push({ email: credential.email, login: true, tenant: accountName, warehouseCodes: visibleWarehouseCodes, orderRows: 0, inventoryRows: 0 });
    }

    const sentEmails = [];
    for (const credential of credentials) {
        const logResult = await client.query(
            `insert into email_delivery_log (
                status, provider, from_address,
                to_addresses, cc_addresses, bcc_addresses, reply_to, subject,
                account_name, source_type, source_ref, delivery_key, metadata
             ) values (
                'PENDING',$1,$2,$3::jsonb,'[]'::jsonb,'[]'::jsonb,$4,$5,
                $6,'PORTAL_ACCESS',$7,$8,$9::jsonb
             ) returning id`,
            [
                process.env.RESEND_API_KEY ? "RESEND" : "SMTP", FROM,
                JSON.stringify([credential.email]), REPLY_TO,
                "Your WMS365 Customer Portal Access - Blueprint Wholesale",
                ACCOUNT_NAME, credential.email,
                `BLUEPRINT-PORTAL-WELCOME-20260910:${credential.email}`,
                JSON.stringify({ tested: true, tenantIsolation: true, warehouseCodes: [WAREHOUSE_CODE], recipientName: credential.name })
            ]
        );
        const logId = logResult.rows[0].id;
        try {
            const sent = await sendEmail(credential, credential.password);
            await client.query(
                `update email_delivery_log
                 set status='SENT', provider=$2, message_id=$3, provider_response=$4,
                     sent_at=now(), error_message='', updated_at=now()
                 where id=$1`,
                [logId, sent.provider, sent.messageId, sent.providerResponse]
            );
            sentEmails.push({ email: credential.email, provider: sent.provider, messageId: sent.messageId, logId: String(logId) });
        } catch (error) {
            await client.query(
                `update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1`,
                [logId, String(error.message || error).slice(0, 2000)]
            );
            throw error;
        }
    }

    const finalAudit = await Promise.all([
        client.query(`select name, legal_name, account_code, contact_name, email, phone, mobile, website, billing_email, address1, address2, city, state, postal_code, country, note, is_active from owner_accounts where name=$1`, [ACCOUNT_NAME]),
        client.query(`select f.code, f.name, c.is_primary, c.allow_inbound, c.allow_outbound, c.allow_storage, c.allow_returns from company_fulfillment_locations c join fulfillment_locations f on f.id=c.fulfillment_location_id where c.account_name=$1`, [ACCOUNT_NAME]),
        client.query(`select email, is_active, portal_permissions from portal_vendor_access where account_name=$1 order by email`, [ACCOUNT_NAME]),
        client.query(`select code, location_type, is_pickable, account_name from bin_locations where account_name=$1 order by code`, [ACCOUNT_NAME])
    ]);
    console.log(JSON.stringify({
        mode: "apply",
        ok: true,
        company: finalAudit[0].rows,
        warehouses: finalAudit[1].rows,
        portalUsers: finalAudit[2].rows,
        locations: finalAudit[3].rows,
        verificationResults,
        sentEmails
    }, null, 2));
    await client.end();
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
