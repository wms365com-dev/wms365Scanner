const { Pool } = require("pg");

const ACCOUNT = "PURE FOODS BY ESTEE";
const REQUEST = "KIT-000030";
const TARGET_SKU = "174";
const QUANTITY = 116;
const LOCATION = "GW3PL-MISS-PUREFOODS-BULK";
const TYPE = "PORTAL_KITTING_STATUS";
const DELIVERY_KEY = "KITTING-COMPLETED-KIT-000030-PURE-FOODS-20261026";
const SYSTEM_TO = "support@wms365.co";

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

async function main() {
    if (!process.env.RESEND_API_KEY) throw new Error("The production email provider is not configured.");
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    let logId = null;
    try {
        const [request, inventory, contacts, preferences, existing] = await Promise.all([
            pool.query(
                `select request_code,status,target_sku,target_quantity,completed_at,fulfillment_location_id
                 from portal_kitting_requests where request_code=$1 and account_name=$2`,
                [REQUEST, ACCOUNT]
            ),
            pool.query(
                `select coalesce(sum(i.quantity),0)::integer on_hand,
                        coalesce(sum(i.quantity),0)::integer
                          - coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                                      join portal_orders o on o.id=a.order_id
                                      where a.sku=$2 and o.account_name=$1
                                        and o.status in ('RELEASED','PICKING','PICKED','STAGED')),0)::integer available,
                        bool_and(b.is_pickable and b.location_type='STORAGE' and b.fulfillment_location_id=1) pickable
                 from inventory_lines i join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=$2`,
                [ACCOUNT, TARGET_SKU]
            ),
            pool.query(
                `select email from portal_vendor_access
                 where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>'' order by id`,
                [ACCOUNT]
            ),
            pool.query(
                `select lower(email) email,is_subscribed from customer_email_preferences
                 where account_name=$1 and notification_type in ($2,'*')`,
                [ACCOUNT, TYPE]
            ),
            pool.query("select status,message_id from email_delivery_log where delivery_key=$1", [DELIVERY_KEY]),
        ]);
        if (existing.rows[0]?.status === "SENT") {
            return console.log(JSON.stringify({ sent: true, duplicatePrevented: true, messageId: existing.rows[0].message_id || "" }));
        }
        const kit = request.rows[0];
        const stock = inventory.rows[0];
        if (!kit || kit.status !== "COMPLETED" || kit.target_sku !== TARGET_SKU
            || Number(kit.target_quantity) !== QUANTITY || Number(kit.fulfillment_location_id) !== 1
            || Number(stock?.on_hand) !== QUANTITY || Number(stock?.available) !== QUANTITY || stock?.pickable !== true) {
            throw new Error("The completed kitting transaction did not pass the pre-email verification.");
        }
        const optedOut = new Set(preferences.rows.filter((row) => row.is_subscribed === false).map((row) => normalizeEmail(row.email)));
        const recipients = [...new Set(contacts.rows.map((row) => normalizeEmail(row.email)).filter(Boolean))]
            .filter((email) => !optedOut.has(email));
        if (!recipients.length) throw new Error("No subscribed Pure Foods portal contacts are available for this notice.");
        const subject = `Kitting Request Completed - ${REQUEST} - Pure Foods`;
        const text = [
            "Hello Pure Foods team,",
            "",
            `Kitting request ${REQUEST} has been completed in WMS365.`,
            "",
            `Finished item: ${TARGET_SKU} - 3 Case Pre-Filled Holiday Shipper`,
            `Completed quantity: ${QUANTITY} cases`,
            `Available for order release: ${QUANTITY} cases`,
            "Warehouse: Grey Wolf 3PL - Mississauga",
            "",
            "The finished inventory is now available for picking against customer orders.",
            "",
            "Regards,",
            "WMS365 Support",
        ].join("\n");
        const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55">
<p>Hello Pure Foods team,</p>
<p>Kitting request <strong>${REQUEST}</strong> has been completed in WMS365.</p>
<table style="border-collapse:collapse;width:100%;max-width:640px">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished item</td><td style="padding:8px;border:1px solid #d9e2e8">${TARGET_SKU} - 3 Case Pre-Filled Holiday Shipper</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Completed quantity</td><td style="padding:8px;border:1px solid #d9e2e8">${QUANTITY} cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Available for order release</td><td style="padding:8px;border:1px solid #d9e2e8">${QUANTITY} cases</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Warehouse</td><td style="padding:8px;border:1px solid #d9e2e8">Grey Wolf 3PL - Mississauga</td></tr>
</table>
<p>The finished inventory is now available for picking against customer orders.</p>
<p>Regards,<br>WMS365 Support</p>
</body></html>`;
        const log = await pool.query(
            `insert into email_delivery_log (
                status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
                account_name,source_type,source_ref,delivery_key,metadata
             ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                       'support@wms365.co',$3,$4,$5,$6,$7,$8::jsonb)
             on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now()
             returning id`,
            [JSON.stringify([SYSTEM_TO]), JSON.stringify(recipients), subject, ACCOUNT, TYPE, REQUEST, DELIVERY_KEY,
                JSON.stringify({ targetSku: TARGET_SKU, completedQuantity: QUANTITY, availableQuantity: QUANTITY,
                    location: LOCATION, recipientSource: "ACTIVE_ACCOUNT_PORTAL_USERS", addressing: "BCC_ONLY" })]
        );
        logId = log.rows[0].id;
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": DELIVERY_KEY,
            },
            body: JSON.stringify({
                from: "WMS365 <support@wms365.co>",
                to: [SYSTEM_TO],
                cc: [],
                bcc: recipients,
                reply_to: SYSTEM_TO,
                subject,
                text,
                html,
            }),
            signal: AbortSignal.timeout(30000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await pool.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now()
             where id=$1`,
            [logId, payload.id || "", "Resend accepted the BCC-only message."]
        );
        console.log(JSON.stringify({ sent: true, providerAccepted: true, messageId: payload.id || "",
            recipientCount: recipients.length, toSystemAddress: true, ccCount: 0, bccOnly: true }));
    } catch (error) {
        if (logId) {
            await pool.query(
                "update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",
                [logId, String(error.message || error).slice(0, 2000)]
            ).catch(() => {});
        }
        throw error;
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
