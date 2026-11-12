const { Client } = require("pg");
const { APP_USER_ROLES, updateAdminPortalInboundStatus, withTransaction } = require("../server");

const ACCOUNT = "HEALTEA";
const WAREHOUSE = "GW3PL-MISS";
const WAREHOUSE_ID = "1";
const LOCATION = "GW3PL-MISS-HEALTEA-BULK";
const EMAIL_KEY = "HEALTEA-INB-000197-199-RECEIVED-AVAILABLE-LOTS";
const APPLY = process.argv.includes("--apply");
const ACTOR = { role: APP_USER_ROLES.SUPER_ADMIN, full_name: "WMS365 Owner Approved Receiving" };
const MANIFEST = [
    { code: "INB-000197", reference: "INT000056", lines: [
        { sku: "30627843973301", quantity: 715, pallets: 4, lot: "60918", expiry: "2028-09-18" },
        { sku: "30628693486072", quantity: 1627, pallets: 9, lot: "60921", expiry: "2028-09-21" },
        { sku: "20628693486143", quantity: 744, pallets: 8, lot: "60918", expiry: "2028-09-18" }
    ] },
    { code: "INB-000198", reference: "INT000057-1", lines: [
        { sku: "TRAY12", quantity: 1800, pallets: 1, lot: "", expiry: "" }
    ] },
    { code: "INB-000199", reference: "INT000056-2", lines: [
        { sku: "30628693486072", quantity: 180, pallets: 1, lot: "60921", expiry: "2028-09-21" }
    ] }
];

function connection() {
    return new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
}

async function loadState(client, lock = false) {
    const codes = MANIFEST.map((inbound) => inbound.code);
    const inboundResult = await client.query(
        `select i.*,fl.code warehouse_code from portal_inbounds i
         join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         where i.account_name=$1 and i.inbound_code=any($2::text[])
         order by i.inbound_code${lock ? " for update of i" : ""}`,
        [ACCOUNT, codes]
    );
    const ids = inboundResult.rows.map((row) => row.id);
    const lineResult = await client.query(
        `select l.*,c.description,c.tracking_level,c.lot_tracked,c.expiration_tracked,c.blocked
         from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
         where l.inbound_id=any($1::bigint[]) order by l.inbound_id,l.line_number,l.id${lock ? " for update of l" : ""}`,
        [ids, ACCOUNT]
    );
    const binResult = await client.query("select * from bin_locations where code=$1", [LOCATION]);
    const accessResult = await client.query(
        `select 1 from company_fulfillment_locations where account_name=$1 and fulfillment_location_id=$2
         and allow_inbound=true and allow_storage=true`, [ACCOUNT, WAREHOUSE_ID]
    );
    const recipientsResult = await client.query(
        `select email from portal_vendor_access where account_name=$1 and is_active=true order by email`, [ACCOUNT]
    );
    const emails = [...new Set(recipientsResult.rows.map((row) => String(row.email || "").trim().toLowerCase()))]
        .filter((email) => /^[^\s@]+@thehealtea\.com$/.test(email));
    return { inbounds: inboundResult.rows, lines: lineResult.rows, bin: binResult.rows[0], access: accessResult.rowCount === 1, emails };
}

function assertState(state, allowCompleted = true) {
    if (state.inbounds.length !== MANIFEST.length || !state.access) throw new Error("Exact Healtea inbound or warehouse access verification failed.");
    if (!state.bin || state.bin.account_name !== ACCOUNT || String(state.bin.fulfillment_location_id) !== WAREHOUSE_ID
        || state.bin.location_type !== "STORAGE" || state.bin.is_pickable !== true) throw new Error("Healtea bulk destination verification failed.");
    if (!state.emails.length) throw new Error("No verified active Healtea customer email is available.");
    for (const expectedInbound of MANIFEST) {
        const inbound = state.inbounds.find((row) => row.inbound_code === expectedInbound.code);
        if (!inbound || inbound.reference_number !== expectedInbound.reference || inbound.warehouse_code !== WAREHOUSE
            || String(inbound.fulfillment_location_id) !== WAREHOUSE_ID) throw new Error(`${expectedInbound.code} identity mismatch.`);
        if (!allowCompleted && inbound.status !== "SUBMITTED") throw new Error(`${expectedInbound.code} is ${inbound.status}, not SUBMITTED.`);
        if (!allowCompleted && inbound.received_at) throw new Error(`${expectedInbound.code} already has a receipt timestamp.`);
        const lines = state.lines.filter((line) => String(line.inbound_id) === String(inbound.id));
        if (lines.length !== expectedInbound.lines.length) throw new Error(`${expectedInbound.code} line count changed.`);
        for (const expectedLine of expectedInbound.lines) {
            const line = lines.find((row) => row.sku === expectedLine.sku);
            if (!line || Number(line.expected_quantity) !== expectedLine.quantity || line.blocked) {
                throw new Error(`${expectedInbound.code} ${expectedLine.sku} identity or original quantity changed.`);
            }
        }
    }
}

async function verify(client) {
    const state = await loadState(client);
    assertState(state, true);
    const results = [];
    for (const expectedInbound of MANIFEST) {
        const inbound = state.inbounds.find((row) => row.inbound_code === expectedInbound.code);
        if (inbound.status !== "PUTAWAY_COMPLETE" || !inbound.received_at) throw new Error(`${expectedInbound.code} is not put away.`);
        const ledger = await client.query(
            `select sku,coalesce(sum(quantity_delta),0)::int as quantity,count(*)::int as entries
             from inventory_transactions where account_name=$1 and source_type='PORTAL_INBOUND'
               and source_id=$2 and transaction_type='RECEIVING' group by sku order by sku`,
            [ACCOUNT, String(inbound.id)]
        );
        for (const expectedLine of expectedInbound.lines) {
            const line = state.lines.find((row) => String(row.inbound_id) === String(inbound.id) && row.sku === expectedLine.sku);
            const ledgerLine = ledger.rows.find((row) => row.sku === expectedLine.sku);
            if (Number(line.received_quantity) !== expectedLine.quantity || line.received_location !== LOCATION
                || Number(line.pallet_count) !== expectedLine.pallets || line.lot_number !== expectedLine.lot
                || (line.expiration_date ? new Date(line.expiration_date).toISOString().slice(0, 10) : "") !== expectedLine.expiry
                || Number(ledgerLine?.quantity || 0) !== expectedLine.quantity) {
                throw new Error(`${expectedInbound.code} ${expectedLine.sku} receipt verification failed.`);
            }
        }
        results.push({ code: expectedInbound.code, status: inbound.status,
            casesOrUnits: expectedInbound.lines.reduce((sum, line) => sum + line.quantity, 0),
            pallets: expectedInbound.lines.reduce((sum, line) => sum + line.pallets, 0) });
    }
    return { state, results };
}

async function notifyCustomer() {
    const client = connection();
    await client.connect();
    let logId;
    try {
        const verified = await verify(client);
        const existing = await client.query("select status,message_id from email_delivery_log where delivery_key=$1", [EMAIL_KEY]);
        if (existing.rows[0]?.status === "SENT") {
            console.log(JSON.stringify({ email: "already-sent", messageId: existing.rows[0].message_id }));
            return;
        }
        if (!process.env.RESEND_API_KEY) throw new Error("Resend customer email provider is unavailable.");
        const subject = "Received and Available - INB-000197, INB-000198, INB-000199";
        const text = ["Hello Healtea team,", "",
            "The following inbounds have been received and put away at Grey Wolf 3PL - Mississauga:", "",
            "INB-000197 / INT000056", "- 30627843973301: 715 cases, lot 60918, best before September 18, 2028",
            "- 30628693486072: 1,627 cases, lot 60921, best before September 21, 2028",
            "- 20628693486143: 744 cases, lot 60918, best before September 18, 2028", "",
            "INB-000198 / INT000057-1", "- TRAY12: 1,800 units", "",
            "INB-000199 / INT000056-2", "- 30628693486072: 180 cases, lot 60921, best before September 21, 2028", "",
            "The stock is now in pickable Healtea bulk storage.", "", "Thank you,", "Grey Wolf 3PL & Logistics Inc."].join("\n");
        const logResult = await client.query(
            `insert into email_delivery_log(status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,
                reply_to,subject,account_name,source_type,source_ref,delivery_key,metadata)
             values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb)
             on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now()
             returning id`,
            ["WMS365 <support@wms365.co>", JSON.stringify(["support@wms365.co"]), JSON.stringify(verified.state.emails),
                "support@wms365.co", subject, ACCOUNT, "INBOUND_RECEIVED_AVAILABLE", "INB-000197-199", EMAIL_KEY,
                JSON.stringify({ warehouse: WAREHOUSE, location: LOCATION, inbounds: MANIFEST.map((row) => row.code) })]
        );
        logId = logResult.rows[0].id;
        const response = await fetch(`${process.env.RESEND_API_URL || "https://api.resend.com"}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": EMAIL_KEY },
            body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: ["support@wms365.co"], bcc: verified.state.emails,
                reply_to: "support@wms365.co", subject, text }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) throw new Error(`Resend did not accept customer notice (${response.status}).`);
        await client.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1`,
            [logId, payload.id, `Accepted ${payload.id}`]
        );
        console.log(JSON.stringify({ email: "SENT", messageId: payload.id, recipientCount: verified.state.emails.length }));
    } catch (error) {
        if (logId) await client.query(
            `update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
            [logId, String(error.message || error).slice(0, 2000)]
        ).catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

async function main() {
    await withTransaction(async (client) => {
        if (!APPLY) await client.query("set transaction read only");
        const state = await loadState(client, APPLY);
        const alreadyComplete = state.inbounds.every((row) => row.status === "PUTAWAY_COMPLETE" && row.received_at);
        if (alreadyComplete) {
            const verified = await verify(client);
            console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "PREFLIGHT", outcome: "already-received", receipts: verified.results }, null, 2));
            return;
        }
        assertState(state, false);
        console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "PREFLIGHT", account: ACCOUNT, warehouse: WAREHOUSE,
            destination: LOCATION, inbounds: MANIFEST, customerRecipientCount: state.emails.length }, null, 2));
        if (!APPLY) return;
        const trackedSkus = ["30627843973301", "30628693486072", "20628693486143"];
        const trackedUpdate = await client.query(
            `update item_catalog set lot_tracked=true,expiration_tracked=true,updated_at=now()
             where account_name=$1 and sku=any($2::text[]) and blocked=false returning sku`,
            [ACCOUNT, trackedSkus]
        );
        if (trackedUpdate.rowCount !== trackedSkus.length) throw new Error("Beverage item traceability setup failed.");
        for (const expectedInbound of MANIFEST) {
            const inbound = state.inbounds.find((row) => row.inbound_code === expectedInbound.code);
            const lines = expectedInbound.lines.map((expectedLine) => {
                const line = state.lines.find((row) => String(row.inbound_id) === String(inbound.id) && row.sku === expectedLine.sku);
                return { id: line.id, sku: expectedLine.sku, receivedQuantity: expectedLine.quantity,
                    receivedLocation: LOCATION, lotNumber: expectedLine.lot, expirationDate: expectedLine.expiry };
            });
            for (const expectedLine of expectedInbound.lines) {
                const line = state.lines.find((row) => String(row.inbound_id) === String(inbound.id) && row.sku === expectedLine.sku);
                await client.query("update portal_inbound_lines set pallet_count=$2,updated_at=now() where id=$1", [line.id, expectedLine.pallets]);
            }
            await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", ACTOR, { receivingLocation: LOCATION, lines });
            await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
                note: `${expectedInbound.lines.reduce((sum, line) => sum + line.pallets, 0)} pallets received using original inbound quantities. Lot and expiry recorded from owner-provided product labels.`
            });
        }
        const verified = await verify(client);
        console.log(JSON.stringify({ outcome: "received-and-pickable", receipts: verified.results }, null, 2));
    });
    if (APPLY) await notifyCustomer();
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
