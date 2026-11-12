const { Client } = require("pg");
const { APP_USER_ROLES, updateAdminPortalInboundStatus, withTransaction } = require("../server");

const ACCOUNT = "HEALTEA";
const CODE = "INB-000192";
const REFERENCE = "INT000056";
const SKU = "20628693486167";
const QUANTITY = 1137;
const PALLETS = 12;
const LOT = "60914";
const BEST_BEFORE = "2028-09-14";
const LOCATION = "GW3PL-MISS-HEALTEA-BULK";
const EMAIL_KEY = "HEALTEA-INB-000192-RECEIVED-AVAILABLE";
const APPLY = process.argv.includes("--apply");
const ACTOR = { role: APP_USER_ROLES.SUPER_ADMIN, full_name: "WMS365 Owner Approved Receiving" };

function connection() {
    return new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
}

async function facts(client, lock = false) {
    const result = await client.query(
        `select i.*,fl.code warehouse_code from portal_inbounds i
         join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         where i.inbound_code=$1 and i.account_name=$2${lock ? " for update of i" : ""}`,
        [CODE, ACCOUNT]
    );
    if (result.rowCount !== 1 || result.rows[0].warehouse_code !== "GW3PL-MISS"
        || String(result.rows[0].fulfillment_location_id) !== "1"
        || result.rows[0].reference_number !== REFERENCE) throw Error("Inbound identity mismatch");
    const inbound = result.rows[0];
    const access = await client.query(
        `select 1 from company_fulfillment_locations where account_name=$1 and fulfillment_location_id=1
         and allow_inbound=true and allow_storage=true`, [ACCOUNT]
    );
    if (access.rowCount !== 1) throw Error("Healtea receiving/storage access is missing");
    const lines = await client.query(
        `select l.*,c.description,c.tracking_level,c.lot_tracked,c.expiration_tracked,c.blocked
         from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
         where l.inbound_id=$1 order by l.line_number,l.id`, [inbound.id, ACCOUNT]
    );
    if (lines.rowCount !== 1 || lines.rows[0].sku !== SKU
        || Number(lines.rows[0].expected_quantity) !== QUANTITY
        || lines.rows[0].tracking_level !== "CASE" || !lines.rows[0].lot_tracked
        || !lines.rows[0].expiration_tracked || lines.rows[0].blocked) throw Error("Inbound item or quantity changed");
    const bin = await client.query("select * from bin_locations where code=$1", [LOCATION]);
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT
        || String(bin.rows[0].fulfillment_location_id) !== "1"
        || bin.rows[0].location_type !== "STORAGE" || !bin.rows[0].is_pickable) {
        throw Error("Destination is not Healtea-owned pickable Mississauga storage");
    }
    const foreign = await client.query(
        "select 1 from inventory_lines where location=$1 and account_name<>$2 and quantity<>0 limit 1",
        [LOCATION, ACCOUNT]
    );
    if (foreign.rowCount) throw Error("Destination contains another customer's inventory");
    const ledger = await client.query(
        `select count(*)::integer entries,coalesce(sum(quantity_delta),0)::integer quantity
         from inventory_transactions where account_name=$1 and source_type='PORTAL_INBOUND'
           and source_id=$2 and transaction_type='RECEIVING'`, [ACCOUNT, String(inbound.id)]
    );
    const stock = await client.query(
        `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
         where account_name=$1 and sku=$2 and location=$3 and lot_number=$4 and expiration_date=$5`,
        [ACCOUNT, SKU, LOCATION, LOT, BEST_BEFORE]
    );
    const recipients = await client.query(
        `select email from portal_vendor_access where account_name=$1 and is_active=true order by email`, [ACCOUNT]
    );
    const emails = [...new Set(recipients.rows.map(row => String(row.email || "").trim().toLowerCase()))]
        .filter(email => /^[^\s@]+@thehealtea\.com$/.test(email));
    if (!emails.length) throw Error("No verified active Healtea customer email is available");
    return { inbound, line: lines.rows[0], ledger: ledger.rows[0], stock: Number(stock.rows[0].quantity), emails };
}

async function verify(client, previous = null) {
    const current = await facts(client);
    if (current.inbound.status !== "PUTAWAY_COMPLETE" || !current.inbound.received_at
        || Number(current.line.received_quantity) !== QUANTITY
        || current.line.received_location !== LOCATION
        || Number(current.line.pallet_count) !== PALLETS
        || current.line.lot_number !== LOT
        || (current.line.expiration_date
            ? new Date(current.line.expiration_date).toISOString().slice(0, 10) : "") !== BEST_BEFORE
        || Number(current.ledger.quantity) !== QUANTITY
        || Number(current.ledger.entries) !== 1
        || current.stock < QUANTITY) throw Error("Receipt, pallet, lot, ledger or stock verification failed");
    if (previous && current.stock - previous.stock !== QUANTITY) throw Error("Inventory delta mismatch");
    return current;
}

async function notifyCustomer() {
    const client = connection();
    await client.connect();
    let logId;
    try {
        const current = await verify(client);
        const prior = await client.query("select status from email_delivery_log where delivery_key=$1", [EMAIL_KEY]);
        if (prior.rowCount) {
            console.log(JSON.stringify({ email: "already-recorded", status: prior.rows[0].status }));
            return;
        }
        if (!process.env.RESEND_API_KEY) throw Error("Resend customer email provider is unavailable");
        const subject = `Received and Available - ${CODE} - ${REFERENCE}`;
        const result = await client.query(
            `insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,
                reply_to,subject,account_name,source_type,source_ref,delivery_key,metadata)
             values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb)
             on conflict(delivery_key) do nothing returning id`,
            ["WMS365 <support@wms365.co>", JSON.stringify(["support@wms365.co"]),
                JSON.stringify(current.emails), "support@wms365.co", subject, ACCOUNT,
                "INBOUND_RECEIVED_AVAILABLE", CODE, EMAIL_KEY,
                JSON.stringify({ warehouse: "GW3PL-MISS", pallets: PALLETS, cases: QUANTITY, lot: LOT,
                    bestBefore: BEST_BEFORE, location: LOCATION })]
        );
        if (!result.rowCount) throw Error("Email claim already exists; no duplicate was sent");
        logId = result.rows[0].id;
        const message = ["Hello Healtea team,", "",
            `${CODE} (reference ${REFERENCE}) has been received and put away at Grey Wolf 3PL - Mississauga.`,
            "", `${SKU} - ${current.line.description}: ${QUANTITY} cases on ${PALLETS} pallets.`,
            `Lot: ${LOT}`, `Best before: ${BEST_BEFORE}`, "",
            "The stock is in pickable bulk storage. Available-to-promise quantities reflect any existing reservations.",
            "", "Thank you,", "Grey Wolf 3PL & Logistics Inc."].join("\n");
        const response = await fetch(`${process.env.RESEND_API_URL || "https://api.resend.com"}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json", "Idempotency-Key": EMAIL_KEY },
            body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: ["support@wms365.co"],
                bcc: current.emails, reply_to: "support@wms365.co", subject, text: message }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) throw Error(`Resend did not accept customer notice (${response.status})`);
        await client.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
                sent_at=now(),updated_at=now() where id=$1`, [logId, payload.id, `Accepted ${payload.id}`]
        );
        console.log(JSON.stringify({ email: "SENT", provider: "RESEND", messageId: payload.id,
            recipientCount: current.emails.length }));
    } catch (error) {
        if (logId) await client.query(
            `update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
            [logId, error.message]
        ).catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

async function main() {
    if (APPLY && process.env.CONFIRM_HEALTEA_INB_000192 !== "APPROVED_1137_CASES_12_PALLETS") {
        throw Error("Explicit receipt confirmation is required");
    }
    await withTransaction(async client => {
        if (!APPLY) await client.query("set transaction read only");
        const before = await facts(client, APPLY);
        console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "PREFLIGHT", inbound: CODE,
            status: before.inbound.status, expectedCases: Number(before.line.expected_quantity),
            palletCount: PALLETS, lot: LOT, bestBefore: BEST_BEFORE, destination: LOCATION,
            activeCustomerRecipients: before.emails.length, priorReceivingLedger: before.ledger.quantity }));
        if (!APPLY) return;
        if (before.inbound.status === "PUTAWAY_COMPLETE") {
            await verify(client);
            console.log(JSON.stringify({ outcome: "already-received", inbound: CODE }));
            return;
        }
        if (before.inbound.status !== "SUBMITTED" || before.inbound.received_at
            || Number(before.ledger.entries) !== 0 || before.line.received_quantity !== null
            || Number(before.line.pallet_count || 0) !== 0) throw Error("Inbound already advanced; duplicate receipt blocked");
        await client.query(
            `update portal_inbound_lines set pallet_count=$2,updated_at=now() where id=$1`,
            [before.line.id, PALLETS]
        );
        await updateAdminPortalInboundStatus(client, before.inbound.id, "RECEIVED", ACTOR, {
            receivingLocation: LOCATION,
            lines: [{ id: before.line.id, sku: SKU, receivedQuantity: QUANTITY,
                receivedLocation: LOCATION, lotNumber: LOT, expirationDate: BEST_BEFORE }]
        });
        await updateAdminPortalInboundStatus(client, before.inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
            note: `${PALLETS} pallets, ${QUANTITY} cases, lot ${LOT}, best before ${BEST_BEFORE}; put away to ${LOCATION}. Per-pallet case quantities were not supplied.`
        });
        await verify(client, before);
        console.log(JSON.stringify({ outcome: "received-and-pickable", inbound: CODE,
            casesReceived: QUANTITY, pallets: PALLETS, location: LOCATION }));
    });
    if (APPLY) await notifyCustomer();
}

module.exports = { main };
if (require.main === module) main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
