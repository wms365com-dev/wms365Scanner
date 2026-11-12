const { Pool } = require("pg");

const reference = String(process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) || "").trim();
const APPLY = process.argv.includes("--apply");

async function main() {
    if (!reference) throw new Error("Provide an order reference.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const result = await pool.query(
            `select o.id, o.order_code, o.account_name, o.status, o.po_number, o.shipping_reference,
                    p.email as portal_user_email, p.is_active as portal_user_active
             from portal_orders o
             left join portal_vendor_access p on p.id=o.portal_access_id
             where upper(o.order_code)=upper($1) or upper(o.po_number)=upper($1) or upper(o.shipping_reference)=upper($1)
             order by o.id desc`,
            [reference]
        );
        if (result.rowCount !== 1) throw new Error(`${reference} did not match exactly one order.`);
        const order = result.rows[0];
        if (order.status !== "DRAFT") throw new Error(`${order.order_code} is ${order.status}, not open for editing.`);
        if (!order.portal_user_email || order.portal_user_active !== true) throw new Error("The order's original customer portal user is missing or inactive.");
        const recipient = String(order.portal_user_email).trim().toLowerCase();
        const deliveryKey = `ORDER-REOPENED-${order.order_code}-20260915`;
        const subject = `${order.order_code} is open for editing`;
        const text = [
            "Hello,",
            "",
            `${order.order_code} has been reopened in WMS365 and is now available for editing.`,
            "",
            "Please sign in to the customer portal, open Customer Orders, select this order, and add or update the required items and quantities. When the order is complete, save it and release it to the warehouse team.",
            "",
            "Please confirm that every required item and quantity appears on the order before releasing it.",
            "",
            "Customer portal: https://app.wms365.co/portal.html",
            "",
            "WMS365 Support"
        ].join("\n");
        if (!APPLY) {
            console.log(JSON.stringify({ mode: "PREVIEW", order, recipient, subject, text }, null, 2));
            return;
        }
        if (!process.env.RESEND_API_KEY) throw new Error("The email provider is not configured.");
        const existing = await pool.query("select status, message_id from email_delivery_log where delivery_key=$1 limit 1", [deliveryKey]);
        if (existing.rows[0]?.status === "SENT") {
            console.log(JSON.stringify({ mode: "APPLIED", duplicatePrevented: true, recipient, messageId: existing.rows[0].message_id }, null, 2));
            return;
        }
        const log = await pool.query(
            `insert into email_delivery_log (
                status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
                reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
             ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                       'support@wms365.co',$3,$4,'PORTAL_ORDER_REOPENED',$5,$6,$7::jsonb)
             on conflict (delivery_key) do update set status='PENDING', error_message='', failed_at=null, updated_at=now()
             returning id`,
            [JSON.stringify(["support@wms365.co"]), JSON.stringify([recipient]), subject, order.account_name,
                order.order_code, deliveryKey, JSON.stringify({ portalUserEmail: recipient })]
        );
        const logId = log.rows[0].id;
        try {
            const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                    "Content-Type": "application/json",
                    "Idempotency-Key": deliveryKey
                },
                body: JSON.stringify({
                    from: "WMS365 <support@wms365.co>",
                    to: ["support@wms365.co"],
                    bcc: [recipient],
                    reply_to: "support@wms365.co",
                    subject,
                    text,
                    html: `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px"><p>Hello,</p><p><strong>${order.order_code}</strong> has been reopened in WMS365 and is now available for editing.</p><p>Please sign in to the customer portal, open <strong>Customer Orders</strong>, select this order, and add or update the required items and quantities. When the order is complete, save it and release it to the warehouse team.</p><p>Please confirm that every required item and quantity appears on the order before releasing it.</p><p><a href="https://app.wms365.co/portal.html">Open the WMS365 customer portal</a></p><p>WMS365 Support</p></div>`
                }),
                signal: AbortSignal.timeout(30000)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
            await pool.query(
                "update email_delivery_log set status='SENT', message_id=$2, provider_response=$3, sent_at=now(), updated_at=now() where id=$1",
                [logId, payload.id || "", "Resend accepted the order-reopened notice."]
            );
            console.log(JSON.stringify({ mode: "APPLIED", orderCode: order.order_code, recipient, sent: true, messageId: payload.id || "" }, null, 2));
        } catch (error) {
            await pool.query(
                "update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1",
                [logId, String(error.message || error).slice(0, 2000)]
            );
            throw error;
        }
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
