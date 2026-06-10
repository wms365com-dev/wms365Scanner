const crypto = require("crypto");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const ACCOUNT_NAME = "PURE FOODS BY ESTEE";
const RECIPIENT = "k.prathab@gmail.com";
const FROM = "WMS365 <support@wms365.co>";
const REPLY_TO = "support@wms365.co";
const PORTAL_URL = "https://www.wms365.co/portal";
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || "https://app.wms365.co").replace(/\/+$/, "");
const NOTIFICATION_TYPE = "CUSTOMER_DAILY_ACCOUNT_UPDATE";
const TIME_ZONE = "America/Toronto";

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function formatDate(value) {
    if (!value) return "Not set";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Not set";
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: TIME_ZONE
    }).format(date);
}

function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone: TIME_ZONE
    }).format(date);
}

function statusTone(status) {
    const normalized = normalizeText(status);
    if (["RECEIVED", "PUTAWAY_COMPLETE", "SHIPPED"].includes(normalized)) return "#0f7b4f";
    if (["ARRIVED", "PICKED", "STAGED", "PARTIALLY_PUTAWAY"].includes(normalized)) return "#2563eb";
    if (["RELEASED", "SUBMITTED", "RECEIVED_PENDING_PUTAWAY"].includes(normalized)) return "#9a6700";
    if (["CANCELLED", "EXCEPTION", "NEEDS_REVIEW"].includes(normalized)) return "#b42318";
    return "#475569";
}

function labelStatus(status) {
    return normalizeText(status).replace(/_/g, " ") || "OPEN";
}

function buildLink(section, id) {
    const url = new URL(PORTAL_URL);
    url.searchParams.set("view", section);
    if (id) url.searchParams.set(section === "inbounds" ? "inbound" : "order", id);
    return url.toString();
}

function rowOrEmpty(rows, emptyText, colSpan) {
    if (rows.length) return rows.join("");
    return `<tr><td colspan="${colSpan}" style="padding:16px;border-top:1px solid #e5edf3;color:#64748b;">${esc(emptyText)}</td></tr>`;
}

function createUnsubscribeUrl({ accountName = ACCOUNT_NAME, email = RECIPIENT, notificationType = NOTIFICATION_TYPE } = {}) {
    const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET
        || process.env.INTEGRATION_SECRET_KEY
        || process.env.APP_SECRET
        || process.env.SESSION_SECRET
        || "";
    if (!secret) return "";
    const payload = {
        v: 1,
        accountName: normalizeText(accountName),
        email: String(email || "").trim().toLowerCase(),
        notificationType: normalizeText(notificationType)
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
    const url = new URL("/email-preferences/unsubscribe", APP_BASE_URL);
    url.searchParams.set("token", `${encodedPayload}.${signature}`);
    return url.toString();
}

async function getData() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false } });
    try {
        const [orderColumnsResult, inboundColumnsResult, tablesResult] = await Promise.all([
            pool.query("select column_name from information_schema.columns where table_name = 'portal_orders'"),
            pool.query("select column_name from information_schema.columns where table_name = 'portal_inbounds'"),
            pool.query("select table_name from information_schema.tables where table_schema = 'public'")
        ]);
        const orderColumns = new Set(orderColumnsResult.rows.map((row) => row.column_name));
        const inboundColumns = new Set(inboundColumnsResult.rows.map((row) => row.column_name));
        const tables = new Set(tablesResult.rows.map((row) => row.table_name));
        const orderColumn = (name, fallback = "null") => orderColumns.has(name) ? name : `${fallback} as ${name}`;
        const inboundColumn = (name, fallback = "null") => inboundColumns.has(name) ? name : `${fallback} as ${name}`;
        const orderValue = (name, fallback = "null") => orderColumns.has(name) ? name : fallback;
        const inboundValue = (name, fallback = "null") => inboundColumns.has(name) ? name : fallback;
        const hasAllocations = tables.has("portal_order_allocations");
        const allocationJoin = hasAllocations
            ? `
                left join (
                    select
                        a.inventory_line_id,
                        coalesce(sum(a.allocated_quantity), 0)::integer as active_quantity
                    from portal_order_allocations a
                    join portal_orders o on o.id = a.order_id
                    where o.status = any($2::text[])
                      and a.inventory_line_id is not null
                    group by a.inventory_line_id
                ) alloc on alloc.inventory_line_id = i.id
            `
            : "";
        const reservedExpression = hasAllocations ? "coalesce(sum(alloc.active_quantity), 0)::integer" : "0::integer";
        const inventoryParams = hasAllocations ? [ACCOUNT_NAME, ["RELEASED", "PICKED", "STAGED"]] : [ACCOUNT_NAME];
        const [inboundsResult, ordersResult, inventoryResult] = await Promise.all([
            pool.query(
                `
                    select id,
                           ${inboundColumn("inbound_code")},
                           ${inboundColumn("reference_number", "''")},
                           status,
                           ${inboundColumn("carrier_name", "''")},
                           ${inboundColumn("expected_date")},
                           ${inboundColumn("arrived_at")},
                           ${inboundColumn("received_at")},
                           updated_at
                    from portal_inbounds
                    where account_name = $1
                      and status <> 'CANCELLED'
                      and (
                        status <> 'PUTAWAY_COMPLETE'
                        or coalesce(received_at, updated_at, created_at) >= now() - interval '7 days'
                      )
                    order by
                        case status
                            when 'SUBMITTED' then 1
                            when 'ARRIVED' then 2
                            when 'RECEIVED_PENDING_PUTAWAY' then 3
                            when 'PARTIALLY_PUTAWAY' then 4
                            when 'RECEIVED' then 5
                            when 'PUTAWAY_COMPLETE' then 6
                            else 9
                        end,
                        coalesce(${inboundValue("expected_date")}::date, ${inboundValue("received_at")}::date, updated_at::date) asc,
                        id desc
                    limit 8
                `,
                [ACCOUNT_NAME]
            ),
            pool.query(
                `
                    select id,
                           ${orderColumn("order_code")},
                           ${orderColumn("po_number", "''")},
                           ${orderColumn("shipping_reference", "''")},
                           status,
                           ${orderColumn("requested_ship_date")},
                           ${orderColumn("expected_ready_date")},
                           ${orderColumn("rush_requested", "false")},
                           ${orderColumn("released_at")},
                           ${orderColumn("picked_at")},
                           ${orderColumn("staged_at")},
                           ${orderColumn("shipped_at")},
                           updated_at
                    from portal_orders
                    where account_name = $1
                      and status not in ('ARCHIVED', 'CANCELLED')
                      and (
                        status <> 'SHIPPED'
                        or coalesce(shipped_at, updated_at, created_at) >= now() - interval '7 days'
                      )
                    order by
                        case status
                            when 'RELEASED' then 1
                            when 'PICKED' then 2
                            when 'STAGED' then 3
                            when 'DRAFT' then 4
                            when 'SHIPPED' then 5
                            else 9
                        end,
                        coalesce(${orderValue("expected_ready_date")}::date, ${orderValue("requested_ship_date")}::date, updated_at::date) asc,
                        id desc
                    limit 10
                `,
                [ACCOUNT_NAME]
            ),
            pool.query(
                `
                    select
                        i.sku,
                        coalesce(max(c.description), '') as description,
                        count(distinct nullif(i.location, ''))::integer as location_count,
                        coalesce(sum(i.quantity), 0)::integer as on_hand_quantity,
                        ${reservedExpression} as reserved_quantity,
                        greatest(coalesce(sum(i.quantity), 0)::integer - ${reservedExpression}, 0)::integer as available_quantity,
                        max(i.updated_at) as last_updated_at
                    from inventory_lines i
                    left join item_catalog c
                      on c.account_name = i.account_name
                     and c.sku = i.sku
                    ${allocationJoin}
                    where i.account_name = $1
                      and coalesce(i.quantity, 0) <> 0
                    group by i.sku
                    order by i.sku asc
                    limit 15
                `,
                inventoryParams
            )
        ]);
        return {
            inbounds: inboundsResult.rows,
            orders: ordersResult.rows,
            inventory: inventoryResult.rows
        };
    } finally {
        await pool.end();
    }
}

function buildHtml({ inbounds, orders, inventory = [], unsubscribeUrl = "" }) {
    const now = new Date();
    const openInbounds = inbounds.filter((row) => !["RECEIVED", "PUTAWAY_COMPLETE", "CANCELLED"].includes(normalizeText(row.status))).length;
    const activeOrders = orders.filter((row) => !["SHIPPED", "CANCELLED", "ARCHIVED"].includes(normalizeText(row.status))).length;
    const shippingTodayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
    const shippingToday = orders.filter((row) => row.expected_ready_date && new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(row.expected_ready_date)) === shippingTodayKey).length;
    const exceptions = orders.filter((row) => ["EXCEPTION", "NEEDS_REVIEW"].includes(normalizeText(row.status))).length;
    const activeSkuCount = inventory.length;
    const totalAvailable = inventory.reduce((sum, row) => sum + Number(row.available_quantity || 0), 0);

    const inboundRows = inbounds.map((row) => {
        const status = labelStatus(row.status);
        const dateText = row.received_at ? `Received ${formatDate(row.received_at)}` : (row.arrived_at ? `Arrived ${formatDate(row.arrived_at)}` : `Expected ${formatDate(row.expected_date)}`);
        return `
            <tr>
                <td style="padding:12px;border-top:1px solid #e5edf3;"><a href="${esc(buildLink("inbounds", row.id))}" style="color:#0f6f8c;font-weight:700;text-decoration:none;">${esc(row.inbound_code || `INB-${row.id}`)}</a></td>
                <td style="padding:12px;border-top:1px solid #e5edf3;">${esc(row.reference_number || "-")}</td>
                <td style="padding:12px;border-top:1px solid #e5edf3;"><span style="color:${statusTone(status)};font-weight:700;">${esc(status)}</span></td>
                <td style="padding:12px;border-top:1px solid #e5edf3;">${esc(dateText)}</td>
                <td style="padding:12px;border-top:1px solid #e5edf3;"><a href="${esc(buildLink("inbounds", row.id))}" style="color:#0f6f8c;">View</a></td>
            </tr>
        `;
    });

    const inventoryRows = inventory.map((row) => `
        <tr>
            <td style="padding:12px;border-top:1px solid #e5edf3;"><strong>${esc(row.sku)}</strong></td>
            <td style="padding:12px;border-top:1px solid #e5edf3;">${esc(row.description || "-")}</td>
            <td align="right" style="padding:12px;border-top:1px solid #e5edf3;">${esc(Number(row.on_hand_quantity || 0).toLocaleString("en-US"))}</td>
            <td align="right" style="padding:12px;border-top:1px solid #e5edf3;">${esc(Number(row.reserved_quantity || 0).toLocaleString("en-US"))}</td>
            <td align="right" style="padding:12px;border-top:1px solid #e5edf3;"><strong>${esc(Number(row.available_quantity || 0).toLocaleString("en-US"))}</strong></td>
            <td align="right" style="padding:12px;border-top:1px solid #e5edf3;">${esc(Number(row.location_count || 0).toLocaleString("en-US"))}</td>
        </tr>
    `);

    const orderRows = orders.map((row) => {
        const status = labelStatus(row.status);
        const reference = row.po_number || row.shipping_reference || "-";
        const expected = row.expected_ready_date || row.requested_ship_date;
        return `
            <tr>
                <td style="padding:12px;border-top:1px solid #e5edf3;"><a href="${esc(buildLink("orders", row.id))}" style="color:#0f6f8c;font-weight:700;text-decoration:none;">${esc(row.order_code || `ORD-${row.id}`)}</a></td>
                <td style="padding:12px;border-top:1px solid #e5edf3;">${esc(reference)}</td>
                <td style="padding:12px;border-top:1px solid #e5edf3;"><span style="color:${statusTone(status)};font-weight:700;">${esc(status)}</span>${row.rush_requested ? ' <span style="color:#b42318;font-weight:700;">RUSH</span>' : ""}</td>
                <td style="padding:12px;border-top:1px solid #e5edf3;">${esc(formatDate(expected))}</td>
                <td style="padding:12px;border-top:1px solid #e5edf3;"><a href="${esc(buildLink("orders", row.id))}" style="color:#0f6f8c;">View</a></td>
            </tr>
        `;
    });

    return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f7fa;font-family:Arial,Helvetica,sans-serif;color:#172b3a;">
    <div style="display:none;max-height:0;overflow:hidden;">Pure Foods daily WMS365 update: inbounds, sales orders, and items needing attention.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fa;margin:0;padding:24px 0;">
        <tr>
            <td align="center" style="padding:0 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;background:#ffffff;border:1px solid #dbe5ec;border-radius:12px;overflow:hidden;">
                    <tr>
                        <td style="padding:26px 28px;background:#163447;color:#ffffff;">
                            <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#b9d4e4;">WMS365 Daily Account Update</div>
                            <h1 style="margin:8px 0 4px;font-size:26px;line-height:1.2;">Pure Foods By Estee</h1>
                            <div style="font-size:14px;color:#dcecf5;">Sample generated ${esc(formatDateTime(now))}</div>
                            <div style="margin-top:14px;font-size:13px;color:#dcecf5;">Recommended schedule: sent daily at 6:00 PM local warehouse time.</div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:22px 28px;">
                            <a href="${esc(PORTAL_URL)}" style="display:inline-block;background:#0f6f8c;color:#ffffff;text-decoration:none;font-weight:700;border-radius:8px;padding:12px 18px;">View WMS365 Dashboard</a>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0 28px 20px;">
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    ${[
                                        ["Open Inbounds", openInbounds],
                                        ["Active Orders", activeOrders],
                                        ["Active SKUs", activeSkuCount],
                                        ["Available Cases", totalAvailable]
                                    ].map(([label, value]) => `
                                        <td style="width:25%;padding:6px;">
                                            <div style="border:1px solid #dbe5ec;border-radius:10px;padding:14px;background:#f8fbfd;">
                                                <div style="font-size:24px;font-weight:800;color:#163447;">${esc(value)}</div>
                                                <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
                                            </div>
                                        </td>
                                    `).join("")}
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:8px 28px 18px;">
                            <h2 style="margin:0 0 10px;font-size:18px;">Inbound Shipments</h2>
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe5ec;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
                                <tr style="background:#eef5f8;color:#29465a;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">
                                    <th align="left" style="padding:10px;">Inbound</th>
                                    <th align="left" style="padding:10px;">Reference</th>
                                    <th align="left" style="padding:10px;">Status</th>
                                    <th align="left" style="padding:10px;">Date</th>
                                    <th align="left" style="padding:10px;">Action</th>
                                </tr>
                                ${rowOrEmpty(inboundRows, "No active inbounds to show for this sample window.", 5)}
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:8px 28px 22px;">
                            <h2 style="margin:0 0 10px;font-size:18px;">Sales Orders</h2>
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe5ec;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
                                <tr style="background:#eef5f8;color:#29465a;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">
                                    <th align="left" style="padding:10px;">Order</th>
                                    <th align="left" style="padding:10px;">Reference</th>
                                    <th align="left" style="padding:10px;">Status</th>
                                    <th align="left" style="padding:10px;">Expected Ship</th>
                                    <th align="left" style="padding:10px;">Action</th>
                                </tr>
                                ${rowOrEmpty(orderRows, "No active sales orders to show for this sample window.", 5)}
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:8px 28px 22px;">
                            <h2 style="margin:0 0 10px;font-size:18px;">Inventory Snapshot</h2>
                            <div style="margin:0 0 10px;color:#64748b;font-size:13px;">Active stock as of this daily update. Pure Foods quantities are shown in cases unless a SKU is set up as units.</div>
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe5ec;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
                                <tr style="background:#eef5f8;color:#29465a;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">
                                    <th align="left" style="padding:10px;">SKU</th>
                                    <th align="left" style="padding:10px;">Description</th>
                                    <th align="right" style="padding:10px;">On Hand</th>
                                    <th align="right" style="padding:10px;">Reserved</th>
                                    <th align="right" style="padding:10px;">Available</th>
                                    <th align="right" style="padding:10px;">Locations</th>
                                </tr>
                                ${rowOrEmpty(inventoryRows, "No active stock to show for this account.", 6)}
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0 28px 26px;">
                            <div style="border-left:4px solid #0f6f8c;background:#f0f7fb;padding:14px 16px;border-radius:8px;color:#29465a;">
                                <strong>How to use this email:</strong> Click View to open WMS365, sign in, and review the inbound or order. This daily summary is informational only.
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:20px 28px;background:#f8fbfd;border-top:1px solid #dbe5ec;color:#64748b;font-size:13px;line-height:1.5;">
                            This is an automated WMS365 notification. Please make changes directly in WMS365 instead of replying to this email.<br>
                            Need help? Contact <a href="mailto:support@wms365.co" style="color:#0f6f8c;">support@wms365.co</a>.<br>
                            ${unsubscribeUrl
                                ? `Do not want this daily update? <a href="${esc(unsubscribeUrl)}" style="color:#0f6f8c;">Unsubscribe from daily account updates</a>.`
                                : `Do not want this daily update? Email <a href="mailto:support@wms365.co?subject=Unsubscribe%20Daily%20Account%20Update%20-%20Pure%20Foods" style="color:#0f6f8c;">support@wms365.co</a>.`}
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

function buildText({ inbounds, orders, inventory = [], unsubscribeUrl = "" }) {
    return [
        "WMS365 Daily Account Update",
        ACCOUNT_NAME,
        `Sample generated ${formatDateTime(new Date())}`,
        "Recommended schedule: daily at 6:00 PM local warehouse time.",
        "",
        `Dashboard: ${PORTAL_URL}`,
        "",
        "Inbound Shipments:",
        ...(inbounds.length ? inbounds.map((row) => `- ${row.inbound_code || `INB-${row.id}`} | ${row.reference_number || "-"} | ${labelStatus(row.status)} | ${formatDate(row.expected_date || row.received_at || row.updated_at)}`) : ["- No active inbounds to show."]),
        "",
        "Sales Orders:",
        ...(orders.length ? orders.map((row) => `- ${row.order_code || `ORD-${row.id}`} | ${row.po_number || row.shipping_reference || "-"} | ${labelStatus(row.status)} | Expected ship ${formatDate(row.expected_ready_date || row.requested_ship_date)}`) : ["- No active sales orders to show."]),
        "",
        "Inventory Snapshot:",
        ...(inventory.length ? inventory.map((row) => `- ${row.sku} | On hand ${Number(row.on_hand_quantity || 0).toLocaleString("en-US")} | Reserved ${Number(row.reserved_quantity || 0).toLocaleString("en-US")} | Available ${Number(row.available_quantity || 0).toLocaleString("en-US")} | Locations ${Number(row.location_count || 0).toLocaleString("en-US")}`) : ["- No active stock to show."]),
        "",
        "This is an automated WMS365 notification. Please make changes directly in WMS365 instead of replying to this email.",
        "Need help? support@wms365.co",
        unsubscribeUrl
            ? `Unsubscribe from daily account updates: ${unsubscribeUrl}`
            : "To unsubscribe from this daily account update, email support@wms365.co."
    ].join("\n");
}

async function sendViaResend(mail) {
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: FROM,
            to: [RECIPIENT],
            reply_to: REPLY_TO,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            headers: mail.unsubscribeUrl ? {
                "List-Unsubscribe": `<${mail.unsubscribeUrl}>`
            } : undefined
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || data.error || `Resend failed with HTTP ${response.status}`);
    }
    return { provider: "RESEND", messageId: data.id || "" };
}

async function sendViaSmtp(mail) {
    const port = Number.parseInt(process.env.SMTP_PORT || "0", 10);
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ""),
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined
    });
    const info = await transporter.sendMail({
        from: FROM,
        to: RECIPIENT,
        replyTo: REPLY_TO,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: mail.unsubscribeUrl ? {
            "List-Unsubscribe": `<${mail.unsubscribeUrl}>`
        } : undefined
    });
    return { provider: "SMTP", messageId: info.messageId || "" };
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not available.");
    const data = await getData();
    const unsubscribeUrl = createUnsubscribeUrl();
    const subject = `Sample: WMS365 Daily Update - Pure Foods - ${formatDate(new Date())}`;
    const emailData = { ...data, unsubscribeUrl };
    const mail = {
        subject,
        html: buildHtml(emailData),
        text: buildText(emailData),
        unsubscribeUrl
    };

    if (process.argv.includes("--dry-run")) {
        console.log(JSON.stringify({
            dryRun: true,
            to: RECIPIENT,
            subject,
            inboundCount: data.inbounds.length,
            orderCount: data.orders.length,
            inventoryCount: data.inventory.length,
            hasUnsubscribeUrl: !!unsubscribeUrl,
            htmlLength: mail.html.length
        }, null, 2));
        return;
    }

    const result = process.env.RESEND_API_KEY
        ? await sendViaResend(mail)
        : await sendViaSmtp(mail);
    console.log(JSON.stringify({
        sent: true,
        to: RECIPIENT,
        subject,
        provider: result.provider,
        messageId: result.messageId,
        inboundCount: data.inbounds.length,
        orderCount: data.orders.length,
        inventoryCount: data.inventory.length
    }, null, 2));
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
