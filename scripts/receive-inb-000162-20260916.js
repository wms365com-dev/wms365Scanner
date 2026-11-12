const { Client } = require("pg");
const nodemailer = require("nodemailer");
const { APP_USER_ROLES, withTransaction, updateAdminPortalInboundStatus } = require("../server");

const ACCOUNT = "PURE FOODS BY ESTEE";
const CODE = "INB-000162";
const DESTINATION = "GW3PL-MISS-PUREFOODS-BULK";
const EXPECTED = new Map([["140", 300], ["145", 210]]);
const APPLY = process.argv.includes("--apply");
const KEY = "INB-000162-RECEIVED-AVAILABLE-20260916";
const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "k.prathab@gmail.com", full_name: "WMS365 Owner Approved Receiving" };

async function readFacts(client, lock = false) {
    const result = await client.query(
        `select i.*,fl.code warehouse_code from portal_inbounds i
         join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         where i.inbound_code=$1 and i.account_name=$2${lock ? " for update of i" : ""}`, [CODE, ACCOUNT]
    );
    if (result.rows.length !== 1 || result.rows[0].warehouse_code !== "GW3PL-MISS") throw new Error("Inbound company/warehouse mismatch.");
    const inbound = result.rows[0];
    const access = await client.query(
        `select 1 from company_fulfillment_locations where account_name=$1 and fulfillment_location_id=$2
         and allow_inbound=true and allow_storage=true`, [ACCOUNT, inbound.fulfillment_location_id]
    );
    if (!access.rowCount) throw new Error("Company receiving/storage access is missing.");
    const lines = await client.query(
        `select l.*,c.description,c.tracking_level,c.lot_tracked,c.expiration_tracked,c.blocked
         from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
         where l.inbound_id=$1 order by l.line_number,l.id`, [inbound.id, ACCOUNT]
    );
    if (lines.rows.length !== EXPECTED.size) throw new Error("Unexpected inbound lines.");
    for (const line of lines.rows) {
        if (EXPECTED.get(line.sku) !== Number(line.expected_quantity) || line.tracking_level !== "CASE" || line.blocked
            || (line.lot_tracked && !line.lot_number) || (line.expiration_tracked && !line.expiration_date)) throw new Error(`SKU ${line.sku}: receiving information requires review.`);
    }
    const bin = await client.query("select * from bin_locations where code=$1", [DESTINATION]);
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT || String(bin.rows[0].fulfillment_location_id) !== String(inbound.fulfillment_location_id)
        || !bin.rows[0].is_pickable || bin.rows[0].location_type !== "STORAGE") throw new Error("Destination is not customer-owned pickable Mississauga storage.");
    const foreign = await client.query("select 1 from inventory_lines where location=$1 and account_name<>$2 and quantity<>0 limit 1", [DESTINATION, ACCOUNT]);
    if (foreign.rowCount) throw new Error("Destination contains another company's stock.");
    const stock = await client.query("select sku,coalesce(sum(quantity),0)::integer quantity from inventory_lines where account_name=$1 and location=$2 and sku=any($3::text[]) group by sku", [ACCOUNT, DESTINATION, [...EXPECTED.keys()]]);
    const recipients = await client.query(
        `select email from portal_vendor_access where account_name=$1 and is_active=true
         union select email from owner_accounts where name=$1
         union select portal_login_email from owner_accounts where name=$1
         union select created_by_email from portal_inbounds where id=$2`, [ACCOUNT, inbound.id]
    );
    const emails = [...new Set(recipients.rows.map((row) => String(row.email || "").trim().toLowerCase()).filter((email) => /^[^\s@]+@pure-food\.ca$/.test(email)))];
    if (!emails.length) throw new Error("No verified Pure Foods customer recipient is available.");
    return { inbound, lines: lines.rows, stock: stock.rows, recipients: emails };
}

async function verify(client, facts) {
    const current = await readFacts(client);
    if (current.inbound.status !== "PUTAWAY_COMPLETE") throw new Error("Putaway status verification failed.");
    for (const line of current.lines) {
        if (Number(line.received_quantity) !== EXPECTED.get(line.sku) || line.received_location !== DESTINATION) throw new Error(`SKU ${line.sku}: received quantity/location verification failed.`);
        if (facts) {
            const before = facts.stock.find((entry) => entry.sku === line.sku)?.quantity || 0;
            const after = current.stock.find((entry) => entry.sku === line.sku)?.quantity || 0;
            if (Number(after) - Number(before) !== EXPECTED.get(line.sku)) throw new Error(`SKU ${line.sku}: inventory delta verification failed.`);
        }
    }
    const ledger = await client.query(
        `select sku,sum(quantity_delta)::integer quantity from inventory_transactions
         where account_name=$1 and source_type='PORTAL_INBOUND' and source_id=$2 and transaction_type='RECEIVING' group by sku`, [ACCOUNT, current.inbound.id]
    );
    if (ledger.rows.length !== EXPECTED.size || ledger.rows.some((row) => Number(row.quantity) !== EXPECTED.get(row.sku))) throw new Error("Receiving ledger verification failed.");
    return current;
}

async function emailCustomer(facts) {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let logId;
    try {
        await verify(client);
        const subject = `Received and Available - ${CODE} - Reference ${facts.inbound.reference_number}`;
        const from = "WMS365 <support@wms365.co>";
        const claim = await client.query(
            `insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
                subject,account_name,source_type,source_ref,delivery_key,metadata)
             values('PENDING',$1,$2,'["support@wms365.co"]'::jsonb,'[]'::jsonb,$3::jsonb,'support@wms365.co',$4,$5,'INBOUND_RECEIVED_AVAILABLE',$6,$7,$8::jsonb)
             on conflict(delivery_key) do nothing returning id`,
            [process.env.RESEND_API_KEY ? "RESEND" : process.env.SENDGRID_API_KEY ? "SENDGRID" : "SMTP", from,
                JSON.stringify(facts.recipients), subject, ACCOUNT, CODE, KEY, JSON.stringify({ warehouse: "GW3PL-MISS", quantity: 510, location: DESTINATION })]
        );
        if (!claim.rowCount) {
            const prior = await client.query("select status,sent_at,bcc_addresses from email_delivery_log where delivery_key=$1", [KEY]);
            console.log(JSON.stringify({ emailAlreadyRecorded: prior.rows[0] })); return;
        }
        logId = claim.rows[0].id;
        const text = ["Hello Pure Foods team,", "", `Purchase order ${CODE} (reference ${facts.inbound.reference_number}) has been received in full and put away at Grey Wolf 3PL - Mississauga.`,
            "1330 Courtney Park Drive East, Mississauga, Ontario", "", ...facts.lines.map((line) => `${line.sku} - ${line.description}: ${line.received_quantity} cases`),
            "", "Total received: 510 cases.", "The stock is in a pickable location and available for outbound order allocation. Live available quantities reflect any existing reservations.",
            "", "You can review inventory and enter orders at https://app.wms365.co/portal.html", "", "Thank you,", "Grey Wolf 3PL & Logistics Inc.", "WMS365 - https://wms365.co"].join("\n");
        let provider, messageId, providerResponse;
        if (process.env.RESEND_API_KEY) {
            const response = await fetch(`${process.env.RESEND_API_URL || "https://api.resend.com"}/emails`, {
                method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": KEY },
                body: JSON.stringify({ from, to: ["support@wms365.co"], bcc: facts.recipients, reply_to: "support@wms365.co", subject, text }), signal: AbortSignal.timeout(30000)
            });
            const data = await response.json();
            if (!response.ok) throw new Error(`Resend ${response.status}: ${data.message || "send failed"}`);
            provider = "RESEND"; messageId = data.id; providerResponse = `Accepted ${data.id}`;
        } else if (process.env.SENDGRID_API_KEY) {
            const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
                method: "POST", headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ personalizations: [{ to: [{ email: "support@wms365.co" }], bcc: facts.recipients.map((email) => ({ email })) }],
                    from: { email: "support@wms365.co", name: "WMS365" }, subject, content: [{ type: "text/plain", value: text }] }), signal: AbortSignal.timeout(30000)
            });
            if (!response.ok) throw new Error(`SendGrid ${response.status}`);
            provider = "SENDGRID"; messageId = response.headers.get("x-message-id") || ""; providerResponse = "Accepted";
        } else {
            if (!process.env.SMTP_HOST) throw new Error("No email provider configured.");
            const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
                secure: /^(true|1)$/i.test(process.env.SMTP_SECURE || ""), auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
            const result = await transport.sendMail({ from, to: "support@wms365.co", bcc: facts.recipients, subject, text });
            if (result.rejected?.length) throw new Error("One or more recipients rejected the message.");
            provider = "SMTP"; messageId = result.messageId; providerResponse = result.response;
        }
        await client.query("update email_delivery_log set status='SENT',provider=$2,message_id=$3,provider_response=$4,sent_at=now(),updated_at=now() where id=$1", [logId, provider, messageId || "", providerResponse || ""]);
        console.log(JSON.stringify({ customerEmailSent: true, provider, messageId, bcc: facts.recipients }));
    } catch (error) {
        if (logId) await client.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1", [logId, error.message]).catch(() => {});
        throw error;
    } finally { await client.end(); }
}

async function main() {
    if (APPLY && process.env.CONFIRM_INB162_RECEIVE !== "APPROVED_510_CASES") throw new Error("Receiving confirmation is required.");
    const facts = await withTransaction(async (client) => {
        if (!APPLY) await client.query("set transaction read only");
        const before = await readFacts(client, APPLY);
        console.log(JSON.stringify({ inbound: CODE, account: ACCOUNT, status: before.inbound.status, lines: before.lines.map((line) => ({ sku: line.sku, cases: line.expected_quantity })), destination: DESTINATION, recipients: before.recipients }));
        if (!APPLY) return before;
        if (before.inbound.status === "PUTAWAY_COMPLETE") return verify(client);
        if (!["SUBMITTED", "ARRIVED"].includes(before.inbound.status) || before.inbound.received_at) throw new Error("Inbound already received or not eligible; stopped to prevent duplicate stock.");
        let inbound = await updateAdminPortalInboundStatus(client, before.inbound.id, "RECEIVED", actor, {
            lines: before.lines.map((line) => ({ id: line.id, sku: line.sku, receivedQuantity: EXPECTED.get(line.sku), receivedLocation: DESTINATION,
                lotNumber: line.lot_number || "", expirationDate: line.expiration_date ? line.expiration_date.toISOString().slice(0, 10) : "" }))
        });
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE", actor, { note: "Full quantities physically received and put away to verified customer-owned pickable Grey Wolf Mississauga bulk storage, per owner instruction." });
        const current = await verify(client, before);
        console.log(JSON.stringify({ received: true, status: inbound.status, totalCases: 510, location: DESTINATION, receiptDate: current.inbound.received_at }));
        return current;
    });
    if (APPLY) await emailCustomer(facts);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
