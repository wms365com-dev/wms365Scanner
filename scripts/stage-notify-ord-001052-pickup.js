const { Client } = require("pg");
const { APP_USER_ROLES, updateAdminPortalOrderStatus, getPortalOrderById } = require("../server");

const ACCOUNT = "TRAVEONE LTD.";
const ORDER = "ORD-001052";
const RECIPIENT = "traveoneltd@gmail.com";
const KEY = "ORD-001052-READY-PICKUP-20260917";
const FROM = "WMS365 <support@wms365.co>";
const SUBJECT = "Ready for customer pickup today - ORD-001052";
const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "k.prathab@gmail.com", full_name: "Owner-approved customer pickup staging" };
const expected = new Map([["CORE-280-BLACK-L", 36], ["CORE-280-BLACK-XL", 10]]);

async function main() {
    if (process.env.APPROVE_ORD1052_PICKUP !== "STAGE_AND_NOTIFY_HISHAM") throw new Error("Owner approval is required.");
    if (!process.env.RESEND_API_KEY) throw new Error("Pickup email provider is unavailable.");
    const now = new Date();
    const local = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(now).map(part => [part.type, part.value]));
    if (`${local.year}-${local.month}-${local.day}` !== "2026-09-17" || Number(local.hour) * 60 + Number(local.minute) >= 930) {
        throw new Error("The approved pickup window has ended; do not send an outdated notification.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    await client.connect();
    let logId;
    const text = ["Hello Hisham,", "", "Your Traveone Ltd. order ORD-001052 (PO Just-20) is staged and ready for customer pickup.",
        "", "Pickup window: From now until 3:30 pm Eastern today, September 17, 2026.",
        "", "Pickup address:", "Grey Wolf 3PL & Logistics Inc.", "1330 Courtney Park Drive East", "Mississauga, Ontario",
        "", "Order contents:", "CORE-280-BLACK-L: 36 units", "CORE-280-BLACK-XL: 10 units", "Total: 46 units",
        "", "Please quote ORD-001052 when collecting your order. If you cannot arrive by 3:30 pm, please contact us to arrange another pickup time.",
        "", "Thank you,", "Grey Wolf 3PL & Logistics Inc.", "WMS365 | https://wms365.co"].join("\n");
    try {
        await client.query("begin");
        try {
            const result = await client.query(
                `select o.id,o.status,o.shipment_method,o.fulfillment_location_id,oa.id::text company_id
                 from portal_orders o join owner_accounts oa on oa.name=o.account_name
                 where o.order_code=$1 and o.account_name=$2 for update of o`, [ORDER, ACCOUNT]);
            const row = result.rows[0];
            if (result.rowCount !== 1 || row.company_id !== "1477" || String(row.fulfillment_location_id) !== "1"
                || row.shipment_method !== "CUSTOMER_PICKUP" || !["RELEASED", "PICKED", "STAGED"].includes(row.status)) {
                throw new Error("Order company, warehouse, pickup method or status changed; stopping.");
            }
            const contacts = await client.query("select email from portal_vendor_access where account_name=$1 and lower(email)=$2 and is_active=true", [ACCOUNT, RECIPIENT]);
            if (contacts.rowCount !== 1) throw new Error("Hisham's active company-owned portal contact could not be verified.");
            const lines = await client.query(
                `select l.sku,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::integer allocated
                 from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
                 where l.order_id=$1 group by l.id order by l.id`, [row.id]);
            if (lines.rowCount !== 2 || lines.rows.some(line => Number(line.requested_quantity) !== expected.get(line.sku)
                || Number(line.allocated) !== expected.get(line.sku))) throw new Error("Order quantities or allocations require review.");
            const blocked = await client.query("select 1 from warehouse_tasks where source_type='PORTAL_ORDER' and source_id=$1 and status='BLOCKED' limit 1", [row.id]);
            if (blocked.rowCount) throw new Error("A blocked warehouse task requires review before staging.");
            const note = "Owner confirmed ready for customer pickup September 17, 2026, from now until 15:30 America/Toronto. Notify only Hisham at the verified Traveone company contact. Do not ship.";
            if (row.status === "RELEASED") await updateAdminPortalOrderStatus(client, row.id, "PICKED", { idempotencyKey: `${KEY}-PICKED`, note }, actor);
            if (row.status !== "STAGED") await updateAdminPortalOrderStatus(client, row.id, "STAGED", { idempotencyKey: `${KEY}-STAGED`, note }, actor);
            const saved = await getPortalOrderById(client, row.id, ACCOUNT);
            if (saved.status !== "STAGED" || saved.shippedAt) throw new Error("Staging verification failed.");
            const claim = await client.query(
                `insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
                    subject,account_name,source_type,source_ref,delivery_key,metadata)
                 values('PENDING','RESEND',$1,'["support@wms365.co"]'::jsonb,'[]'::jsonb,$2::jsonb,'support@wms365.co',
                    $3,$4,'CUSTOMER_PICKUP_READY',$5,$6,$7::jsonb)
                 on conflict(delivery_key) do nothing returning id`,
                [FROM, JSON.stringify([RECIPIENT]), SUBJECT, ACCOUNT, ORDER, KEY,
                    JSON.stringify({ pickupDate: "2026-09-17", pickupUntil: "15:30", timeZone: "America/Toronto", units: 46, recipientVerified: true, text })]);
            logId = claim.rows[0]?.id;
            await client.query("commit");
            if (!logId) {
                const previous = await client.query("select status,message_id,bcc_addresses from email_delivery_log where delivery_key=$1", [KEY]);
                console.log(JSON.stringify({ order: ORDER, status: saved.status, duplicateEmailBlocked: true, email: previous.rows[0] }));
                return;
            }
        } catch (error) { await client.query("rollback"); throw error; }

        const response = await fetch("https://api.resend.com/emails", {
            method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": KEY },
            body: JSON.stringify({ from: FROM, to: ["support@wms365.co"], cc: [], bcc: [RECIPIENT], reply_to: "support@wms365.co", subject: SUBJECT, text }),
            signal: AbortSignal.timeout(30000)
        });
        const data = await response.json();
        if (!response.ok || !data.id) {
            await client.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1", [logId, `Provider rejected pickup notification (${response.status})`]);
            throw new Error(`Order staged, but email rejected: ${response.status}. Review before retrying.`);
        }
        await client.query("update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1", [logId, data.id, "Resend accepted pickup-ready email"]);
        const verified = await client.query(
            `select o.order_code,o.account_name,o.status,o.picked_at,o.staged_at,o.shipped_at,e.status email_status,e.bcc_addresses,e.message_id
             from portal_orders o join email_delivery_log e on e.delivery_key=$3
             where o.order_code=$1 and o.account_name=$2`, [ORDER, ACCOUNT, KEY]);
        console.log(JSON.stringify({ verified: true, ...verified.rows[0], pickupUntil: "3:30 pm Eastern September 17, 2026" }, null, 2));
    } finally { await client.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
