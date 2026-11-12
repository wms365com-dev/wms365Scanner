const crypto = require("node:crypto");
const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const INCLUDE_SHIPPED_ORD_001395 = process.argv.includes("--include-shipped-ord-001395");
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
    const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
}

function easternToday(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(now);
}

function formatDate(value) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
    }).format(new Date(`${value}T12:00:00Z`));
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
}

function normalizeDestination(row) {
    return [row.ship_to_name, row.ship_to_address1, row.ship_to_address2, row.ship_to_postal_code]
        .filter(Boolean)
        .join(" ")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}

function isNutem(row) {
    const destination = normalizeDestination(row);
    return destination.includes("NUTEM CUSTOM MANUFACTURING")
        && destination.includes("1105 CLAY AVE")
        && destination.replace(/\s+/g, "").includes("L7L0A1");
}

function buildMessage(row, deliveryDate, appointmentUrl) {
    const formattedDate = formatDate(deliveryDate);
    const subject = `Delivery appointment request - PO ${row.po_number} - ${formattedDate} at ${REQUESTED_TIME}`;
    const lines = [
        "Good evening,",
        "",
        "Can you please confirm a delivery appointment for the following shipment:",
        "",
        `Requested appointment: ${formattedDate} at ${REQUESTED_TIME}`,
        `PO: ${row.po_number}`,
        `WMS order: ${row.order_code}`
    ];
    if (Number(row.outbound_total_pallets) > 0) lines.push(`Total pallets: ${Number(row.outbound_total_pallets)}`);
    if (Number(row.routing_total_weight) > 0) {
        lines.push(`Total weight: ${Number(row.routing_total_weight)} ${String(row.routing_weight_uom || "LB").toLowerCase()}`);
    }
    lines.push(
        "",
        "Delivery address:",
        row.ship_to_name,
        row.ship_to_address1,
        row.ship_to_address2,
        `${row.ship_to_city}, ${row.ship_to_state} ${row.ship_to_postal_code}`,
        row.ship_to_country,
        "",
        "Please use the secure link below to confirm the appointment window.",
        appointmentUrl,
        "",
        "Thank you,",
        "",
        "Grey Wolf 3PL & Logistics Inc."
    );
    const text = lines.filter((line) => line !== null && line !== undefined).join("\n");
    const html = `<div style="font-family:Arial,sans-serif;color:#17324d;line-height:1.5;max-width:680px">${text.split(/\r?\n/).map((line) => (
        line === appointmentUrl
            ? `<p><a href="${escapeHtml(appointmentUrl)}" style="display:inline-block;padding:11px 16px;background:#17677d;color:#fff;text-decoration:none;font-weight:700">Confirm Delivery Appointment</a></p>`
            : line ? `<p style="margin:0 0 10px">${escapeHtml(line)}</p>` : '<div style="height:6px"></div>'
    )).join("")}</div>`;
    return { subject, text, html };
}

async function loadEligibleOrders(client) {
    const result = await client.query(`
        select o.id, o.order_code, o.account_name, o.status, o.po_number,
               o.requested_ship_date::text, o.routing_requested_delivery_date::text,
               o.ship_to_name, o.ship_to_address1, o.ship_to_address2, o.ship_to_city,
               o.ship_to_state, o.ship_to_postal_code, o.ship_to_country,
               o.outbound_total_pallets, o.routing_total_weight, o.routing_weight_uom,
               o.shipped_at, o.routed_at, o.fulfillment_location_id,
               fl.name as warehouse_name
        from portal_orders o
        join fulfillment_locations fl on fl.id = o.fulfillment_location_id
        where o.account_name = $1
          and (
            (o.status not in ('SHIPPED','CANCELLED','ARCHIVED') and o.shipped_at is null)
            or ($3::boolean and o.order_code = 'ORD-001395')
          )
          and coalesce(o.routing_requested_delivery_date, o.requested_ship_date) > $2::date
        order by coalesce(o.routing_requested_delivery_date, o.requested_ship_date), o.id
    `, [ACCOUNT, easternToday(), INCLUDE_SHIPPED_ORD_001395]);
    return result.rows.filter((row) => isNutem(row));
}

async function sendOne(pool, orderId) {
    const client = await pool.connect();
    let logId = null;
    try {
        await client.query("begin");
        const result = await client.query(`
            select o.*, fl.name as warehouse_name
            from portal_orders o
            join fulfillment_locations fl on fl.id = o.fulfillment_location_id
            where o.id = $1 for update of o
        `, [orderId]);
        if (result.rowCount !== 1) throw new Error("Order disappeared before send.");
        const row = result.rows[0];
        const deliveryDate = dateKey(row.routing_requested_delivery_date || row.requested_ship_date);
        const approvedShippedException = INCLUDE_SHIPPED_ORD_001395
            && row.order_code === "ORD-001395"
            && row.status === "SHIPPED"
            && deliveryDate === "2026-10-19";
        if (row.account_name !== ACCOUNT || !isNutem(row) || !row.po_number || !deliveryDate
            || deliveryDate <= easternToday()
            || (!approvedShippedException && (row.shipped_at || ["SHIPPED", "CANCELLED", "ARCHIVED"].includes(row.status)))) {
            throw new Error(`Order ${row.order_code} no longer matches the approved Alcona/Nutem future-order scope.`);
        }
        const deliveryKey = `order-routing:${row.id}`;
        const existing = await client.query("select status from email_delivery_log where delivery_key=$1 limit 1", [deliveryKey]);
        if (existing.rowCount) {
            await client.query("rollback");
            return { orderCode: row.order_code, outcome: "SKIPPED", reason: `existing ${existing.rows[0].status} delivery record` };
        }
        if (row.routed_at) {
            await client.query("rollback");
            return { orderCode: row.order_code, outcome: "SKIPPED", reason: "already routed" };
        }

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const origin = String(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "https://app.wms365.co").replace(/\/+$/, "");
        const appointmentUrl = `${origin}/order-routing-appointment?token=${encodeURIComponent(token)}`;
        const message = buildMessage(row, deliveryDate, appointmentUrl);
        const request = await client.query(`
            insert into order_routing_requests(order_id, token_hash, recipient_email)
            values ($1,$2,$3) returning id
        `, [row.id, tokenHash, RECIPIENT]);
        const log = await client.query(`
            insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
            ) values ('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,
                'ORDER_ROUTING',$8,$9,$10::jsonb) returning id
        `, [
            process.env.SMTP_FROM || "WMS365 <support@wms365.co>",
            JSON.stringify(TO), JSON.stringify(CC), JSON.stringify(BCC), process.env.SMTP_REPLY_TO || "",
            message.subject, ACCOUNT, row.order_code, deliveryKey,
            JSON.stringify({ orderId: row.id, requestedAppointment: `${deliveryDate} ${REQUESTED_TIME}`, routingRequestId: request.rows[0].id })
        ]);
        logId = log.rows[0].id;

        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": deliveryKey
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
        await client.query(`update portal_orders set routing_email=$2,
            routing_requested_delivery_date=$3::date, routed_at=now(), routed_by=$4, updated_at=now()
            where id=$1`, [row.id, RECIPIENT, deliveryDate, "Owner-approved Alcona/Nutem nightly appointment request"]);
        await client.query("commit");
        return { orderCode: row.order_code, outcome: "SENT", subject: message.subject, messageId: provider.id };
    } catch (error) {
        await client.query("rollback").catch(() => {});
        if (logId) await pool.query(`update email_delivery_log set status='FAILED', error_message=$2,
            failed_at=now(), updated_at=now() where id=$1`, [logId, String(error.message || error).slice(0, 2000)]).catch(() => {});
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
        const eligible = await loadEligibleOrders(pool);
        const invalid = eligible.filter((row) => !String(row.po_number || "").trim());
        const ready = eligible.filter((row) => String(row.po_number || "").trim());
        if (!APPLY) {
            const deliveryAudit = await pool.query(`
                select e.source_ref, e.status, e.to_addresses, e.cc_addresses, e.bcc_addresses,
                       e.subject, e.message_id, r.status as appointment_status
                from email_delivery_log e
                join portal_orders o on o.order_code = e.source_ref
                left join order_routing_requests r on r.order_id = o.id
                where e.delivery_key = concat('order-routing:', o.id)
                  and o.id = any($1::bigint[])
                order by o.id
            `, [ready.map((row) => row.id)]);
            console.log(JSON.stringify({
                mode: "READ_ONLY",
                exactAccount: ACCOUNT,
                exactDestination: "NUTEM CUSTOM MANUFACTURING / 1105 CLAY AVE / L7L0A1",
                afterDate: easternToday(),
                requestedTime: REQUESTED_TIME,
                to: TO,
                cc: CC,
                bccCount: BCC.length,
                ready: ready.map((row) => ({
                    orderCode: row.order_code,
                    status: row.status,
                    poNumber: row.po_number,
                    deliveryDate: dateKey(row.routing_requested_delivery_date || row.requested_ship_date),
                    alreadyRouted: Boolean(row.routed_at)
                })),
                deliveryAudit: deliveryAudit.rows,
                blocked: invalid.map((row) => ({ orderCode: row.order_code, reason: "missing PO number" }))
            }, null, 2));
            return;
        }
        const results = [];
        for (const row of ready) results.push(await sendOne(pool, row.id));
        console.log(JSON.stringify({ mode: "APPLY", results, blocked: invalid.map((row) => row.order_code) }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
