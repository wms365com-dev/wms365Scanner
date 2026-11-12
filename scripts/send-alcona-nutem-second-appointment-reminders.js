const crypto = require("node:crypto");
const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ALCONA TRADING LTD";
const RECIPIENT = "shipping.receiving@nutem.com";
const TO = [RECIPIENT];
const CC = [
    "smit@alconatradingltd.ca",
    "d.jain@emotrans-canada.com",
    "prathab@greywolf3pl.com",
    "gworders@greywolf3pl.com"
];
const BCC = [];
const REQUESTED_TIME = "11:00 AM ET";

function dateKey(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    return String(value || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || "";
}

function easternToday(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(now);
}

function formatDate(value) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric"
    }).format(new Date(`${value}T12:00:00Z`));
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
}

function normalizeDestination(row) {
    return [row.ship_to_name, row.ship_to_address1, row.ship_to_address2, row.ship_to_postal_code]
        .filter(Boolean).join(" ").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function isNutem(row) {
    const destination = normalizeDestination(row);
    return destination.includes("NUTEM CUSTOM MANUFACTURING")
        && destination.includes("1105 CLAY AVE")
        && destination.replace(/\s+/g, "").includes("L7L0A1");
}

function buildMessage(row, deliveryDate, appointmentUrl) {
    const formattedDate = formatDate(deliveryDate);
    const subject = `Second reminder - Delivery appointment confirmation - PO ${row.po_number} - ${formattedDate} at ${REQUESTED_TIME}`;
    const lines = [
        "Good morning,", "",
        "This is a second reminder to please confirm the delivery appointment below:",
        "", `Requested appointment: ${formattedDate} at ${REQUESTED_TIME}`,
        `PO: ${row.po_number}`, `WMS order: ${row.order_code}`, "",
        "Please use the secure link below to confirm the appointment window.",
        appointmentUrl, "", "Thank you,", "", "Grey Wolf 3PL & Logistics Inc."
    ];
    const text = lines.join("\n");
    const html = `<div style="font-family:Arial,sans-serif;color:#17324d;line-height:1.5;max-width:680px">${lines.map((line) => (
        line === appointmentUrl
            ? `<p><a href="${escapeHtml(appointmentUrl)}" style="display:inline-block;padding:11px 16px;background:#17677d;color:#fff;text-decoration:none;font-weight:700">Confirm Delivery Appointment</a></p>`
            : line ? `<p style="margin:0 0 10px">${escapeHtml(line)}</p>` : '<div style="height:6px"></div>'
    )).join("")}</div>`;
    return { subject, text, html };
}

async function loadEligible(client) {
    const result = await client.query(`
        select o.*, r.id as routing_request_id, r.status as appointment_status,
               e.status as original_email_status
        from portal_orders o
        join order_routing_requests r on r.order_id = o.id and r.status = 'PENDING'
        join email_delivery_log e on e.delivery_key = concat('order-routing:', o.id)
                               and e.status = 'SENT'
        where o.account_name = $1
          and o.status not in ('SHIPPED','CANCELLED','ARCHIVED')
          and o.shipped_at is null
          and coalesce(o.routing_requested_delivery_date, o.requested_ship_date) >= $2::date
        order by coalesce(o.routing_requested_delivery_date, o.requested_ship_date), o.id
    `, [ACCOUNT, easternToday()]);
    return result.rows.filter((row) => isNutem(row) && String(row.po_number || "").trim());
}

async function sendOne(pool, orderId) {
    const client = await pool.connect();
    let logId = null;
    try {
        await client.query("begin");
        const result = await client.query(`
            select o.*, r.id as routing_request_id, r.status as appointment_status
            from portal_orders o
            join order_routing_requests r on r.order_id = o.id
            where o.id = $1 for update of o, r
        `, [orderId]);
        if (result.rowCount !== 1) throw new Error("Order or routing request disappeared before send.");
        const row = result.rows[0];
        const deliveryDate = dateKey(row.routing_requested_delivery_date || row.requested_ship_date);
        if (row.account_name !== ACCOUNT || !isNutem(row) || row.appointment_status !== "PENDING"
            || !row.po_number || !deliveryDate || deliveryDate < easternToday()
            || row.shipped_at || ["SHIPPED", "CANCELLED", "ARCHIVED"].includes(row.status)) {
            throw new Error(`${row.order_code} no longer matches the approved unconfirmed Nutem scope.`);
        }
        const deliveryKey = `order-routing-reminder-2:${row.id}`;
        const existing = await client.query(
            "select status from email_delivery_log where delivery_key=$1 limit 1", [deliveryKey]
        );
        if (existing.rowCount) {
            await client.query("rollback");
            return { orderCode: row.order_code, outcome: "SKIPPED", reason: `existing ${existing.rows[0].status} reminder record` };
        }

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const origin = String(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "https://app.wms365.co").replace(/\/+$/, "");
        const appointmentUrl = `${origin}/order-routing-appointment?token=${encodeURIComponent(token)}`;
        const message = buildMessage(row, deliveryDate, appointmentUrl);
        await client.query(`
            update order_routing_requests
            set token_hash=$2, expires_at=greatest(now() + interval '14 days', $3::date + interval '1 day'),
                updated_at=now()
            where id=$1 and status='PENDING'
        `, [row.routing_request_id, tokenHash, deliveryDate]);
        const log = await client.query(`
            insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
            ) values ('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,
                'ORDER_ROUTING_REMINDER',$8,$9,$10::jsonb) returning id
        `, [
            process.env.SMTP_FROM || "WMS365 <support@wms365.co>",
            JSON.stringify(TO), JSON.stringify(CC), JSON.stringify(BCC),
            process.env.SMTP_REPLY_TO || "", message.subject, ACCOUNT, row.order_code, deliveryKey,
            JSON.stringify({ orderId: row.id, routingRequestId: row.routing_request_id,
                reminderNumber: 2, requestedAppointment: `${deliveryDate} ${REQUESTED_TIME}` })
        ]);
        logId = log.rows[0].id;
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json", "Idempotency-Key": deliveryKey
            },
            body: JSON.stringify({
                from: process.env.SMTP_FROM || "WMS365 <support@wms365.co>",
                to: TO, cc: CC, bcc: BCC,
                reply_to: process.env.SMTP_REPLY_TO || undefined,
                subject: message.subject, text: message.text, html: message.html
            }),
            signal: AbortSignal.timeout(30000)
        });
        const provider = await response.json().catch(() => ({}));
        if (!response.ok || !provider.id) throw new Error(`Resend rejected ${row.order_code}: ${provider.message || response.statusText}`);
        await client.query(`update email_delivery_log set status='SENT', message_id=$2,
            provider_response=$3, sent_at=now(), updated_at=now() where id=$1`,
        [logId, provider.id, `Resend accepted email with status ${response.status}`]);
        await client.query("commit");
        return { orderCode: row.order_code, outcome: "SENT", messageId: provider.id };
    } catch (error) {
        await client.query("rollback").catch(() => {});
        if (logId) await pool.query(`update email_delivery_log set status='FAILED', error_message=$2,
            failed_at=now(), updated_at=now() where id=$1`,
        [logId, String(error.message || error).slice(0, 2000)]).catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (APPLY && !process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
    const pool = new Pool({ connectionString, max: 2 });
    try {
        const eligible = await loadEligible(pool);
        if (!APPLY) {
            console.log(JSON.stringify({
                mode: "READ_ONLY", exactAccount: ACCOUNT,
                exactDestination: "NUTEM CUSTOM MANUFACTURING / 1105 CLAY AVE / L7L0A1",
                onOrAfterDate: easternToday(), to: TO, ccCount: CC.length, bccCount: BCC.length,
                ready: eligible.map((row) => ({
                    orderCode: row.order_code,
                    deliveryDate: dateKey(row.routing_requested_delivery_date || row.requested_ship_date),
                    appointmentStatus: row.appointment_status
                }))
            }, null, 2));
            return;
        }
        const results = [];
        for (const row of eligible) results.push(await sendOne(pool, row.id));
        console.log(JSON.stringify({ mode: "APPLY", results }, null, 2));
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = { TO, CC, BCC, isNutem, buildMessage };
