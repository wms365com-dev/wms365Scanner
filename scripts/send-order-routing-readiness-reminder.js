const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const {
    getOrderRoutingReadinessSchedule,
    buildOrderRoutingReadinessDeliveryKey,
    buildOrderRoutingReadinessEmailText,
    buildOrderRoutingReadinessEmailHtml,
    getOrderRoutingReadinessWarehouseRecipients
} = require("../server");

const FROM = "WMS365 <support@wms365.co>";
const VISIBLE_RECIPIENT = "support@wms365.co";

function normalizeOrderCode(value) {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    if (!digits) throw new Error("Provide an order code such as ORD-000615.");
    return `ORD-${digits.padStart(6, "0")}`;
}

async function sendViaResend({ deliveryKey, recipients, subject, text, html }) {
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": deliveryKey
        },
        body: JSON.stringify({
            from: FROM,
            to: [VISIBLE_RECIPIENT],
            bcc: recipients,
            reply_to: VISIBLE_RECIPIENT,
            subject,
            text,
            html
        }),
        signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `Resend failed with HTTP ${response.status}`);
    return { provider: "RESEND", messageId: data.id || "", response: data.id ? `Resend accepted email ${data.id}` : "Resend accepted email" };
}

async function sendViaSmtp({ deliveryKey, recipients, subject, text, html }) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number.parseInt(process.env.SMTP_PORT || "0", 10),
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ""),
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined
    });
    const info = await transporter.sendMail({
        from: FROM,
        to: VISIBLE_RECIPIENT,
        bcc: recipients,
        replyTo: VISIBLE_RECIPIENT,
        subject,
        text,
        html,
        headers: { "X-WMS365-Delivery-Key": deliveryKey }
    });
    return { provider: "SMTP", messageId: info.messageId || "", response: info.response || "SMTP accepted email" };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) throw new Error("No system email provider is configured.");
    const orderCode = normalizeOrderCode(process.argv[2]);
    const pool = new Pool({ connectionString, ssl: false });
    let logId = null;
    try {
        const result = await pool.query(
            `select o.*, fl.code as fulfillment_location_code, fl.name as fulfillment_location_name,
                    fl.partner_name as fulfillment_partner_name, fl.state as fulfillment_state,
                    fl.country as fulfillment_country
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             where o.order_code = $1
             limit 1`,
            [orderCode]
        );
        if (result.rowCount !== 1) throw new Error(`${orderCode} was not found.`);
        const row = result.rows[0];
        const order = {
            id: String(row.id),
            orderCode: row.order_code,
            accountName: row.account_name,
            status: row.status,
            poNumber: row.po_number || "",
            requestedShipDate: row.requested_ship_date,
            routingRequestedDeliveryDate: row.routing_requested_delivery_date,
            shipmentMethod: row.shipment_method,
            fulfillmentLocationId: String(row.fulfillment_location_id || ""),
            fulfillmentLocationName: row.fulfillment_location_name || "",
            fulfillmentState: row.fulfillment_state || "",
            fulfillmentCountry: row.fulfillment_country || "",
            routingEmail: row.routing_email || "",
            outboundPallets: { totalPalletsOut: Number(row.outbound_total_pallets) || 0 },
            pickedPalletDetails: Array.isArray(row.picked_pallet_details) ? row.picked_pallet_details : [],
            routingTotalWeight: row.routing_total_weight == null ? null : Number(row.routing_total_weight),
            routedAt: row.routed_at || null
        };
        const location = {
            id: String(row.fulfillment_location_id || ""),
            code: row.fulfillment_location_code || "",
            name: row.fulfillment_location_name || "",
            publicName: row.fulfillment_location_name || row.fulfillment_location_code || "Assigned warehouse",
            partnerName: row.fulfillment_partner_name || "",
            state: row.fulfillment_state || "",
            country: row.fulfillment_country || ""
        };
        const schedule = getOrderRoutingReadinessSchedule(order, { now: new Date(), location });
        if (!schedule.eligible) {
            throw new Error(`${orderCode} is not eligible for a routing-readiness reminder today.`);
        }
        const recipients = await getOrderRoutingReadinessWarehouseRecipients(pool, row.fulfillment_location_id);
        if (!recipients.length) throw new Error(`No active warehouse recipients are assigned to ${location.name || location.code}.`);
        const deliveryKey = buildOrderRoutingReadinessDeliveryKey(order, location, schedule.deliveryDate);
        const subject = `Routing Preparation Due - ${order.orderCode} - ${order.accountName}`;
        const text = buildOrderRoutingReadinessEmailText(order, location, schedule);
        const html = buildOrderRoutingReadinessEmailHtml(order, location, schedule);
        const claim = await pool.query(
            `insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
             ) values ('PENDING',$1,$2,$3::jsonb,'[]'::jsonb,$4::jsonb,$5,$6,$7,'ORDER_ROUTING_READINESS',$8,$9,$10::jsonb)
             on conflict (delivery_key) do nothing
             returning id`,
            [
                process.env.RESEND_API_KEY ? "RESEND" : "SMTP",
                FROM,
                JSON.stringify([VISIBLE_RECIPIENT]),
                JSON.stringify(recipients),
                VISIBLE_RECIPIENT,
                subject,
                order.accountName,
                order.orderCode,
                deliveryKey,
                JSON.stringify({
                    orderId: order.id,
                    fulfillmentLocationId: location.id,
                    deliveryDate: schedule.deliveryDate,
                    reminderDate: schedule.reminderDate,
                    missingFields: schedule.missing
                })
            ]
        );
        if (!claim.rowCount) {
            const existing = await pool.query("select status, sent_at from email_delivery_log where delivery_key=$1 limit 1", [deliveryKey]);
            console.log(JSON.stringify({ sent: false, duplicateBlocked: true, orderCode, deliveryKey, existing: existing.rows[0] || null }, null, 2));
            return;
        }
        logId = claim.rows[0].id;
        const mail = { deliveryKey, recipients, subject, text, html };
        const sent = process.env.RESEND_API_KEY ? await sendViaResend(mail) : await sendViaSmtp(mail);
        await pool.query(
            `update email_delivery_log set status='SENT', provider=$2, message_id=$3,
                provider_response=$4, error_message='', sent_at=now(), updated_at=now() where id=$1`,
            [logId, sent.provider, sent.messageId, sent.response]
        );
        await pool.query(
            "insert into activity_log (type, title, details) values ('order',$1,$2)",
            [
                `Routing preparation reminder sent for ${order.orderCode}`,
                `${order.accountName} | Warehouse ${location.name || location.code} | Delivery ${schedule.deliveryDate} | BCC ${recipients.length} warehouse recipients`
            ]
        );
        console.log(JSON.stringify({
            sent: true,
            orderCode,
            warehouse: location.name || location.code,
            deliveryDate: schedule.deliveryDate,
            reminderDate: schedule.reminderDate,
            status: order.status,
            missing: schedule.missing,
            recipientCount: recipients.length,
            deliveryKey,
            provider: sent.provider,
            messageId: sent.messageId
        }, null, 2));
    } catch (error) {
        if (logId) {
            await pool.query(
                "update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1",
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
