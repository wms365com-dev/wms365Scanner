"use strict";

const { Client, Pool } = require("pg");
const {
  APP_USER_ROLES,
  savePortalInboundForAccount,
  updateAdminPortalInboundStatus,
  buildPortalInboundReceiptPdfAttachment,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "RANCHER'S CHIPS";
const ACCOUNT_ID = "5062";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const REFERENCE = "RANCHERS-NY-REMIX-20261105-2PAL-128CS";
const RECEIVED_DATE = "2026-11-05";
const SKU = "RTC-4OZ-EA";
const UPC = "199284767607";
const CASES = 128;
const UNITS_PER_CASE = 12;
const RECEIVED_UNITS = CASES * UNITS_PER_CASE;
const PALLETS = 2;
const UNITS_PER_PALLET = RECEIVED_UNITS / PALLETS;
const LOT = "091026";
const EXPIRY = "2027-03-02";
const LOCATION = "GW3PL-MISS-RANCH-BULK";
const EMAIL_TYPE = "PORTAL_INBOUND";
const DELIVERY_KEY = `RANCHERS-INBOUND-RECEIVED:${REFERENCE}`;
const SYSTEM_EMAIL = "support@wms365.co";
const ACTOR = {
  id: null,
  email: "operations@wms365.co",
  full_name: "WMS365 Owner-Approved Rancher's Receipt",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

function normalizedEmails(values) {
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

async function loadAndValidateRecipients(db) {
  const [account, warehouse, contacts, preferences] = await Promise.all([
    db.query(`select email,portal_login_email,billing_email,ap_email
                from owner_accounts where id=$1 and name=$2 and is_active=true`, [ACCOUNT_ID, ACCOUNT]),
    db.query(`select billing_contact_email
                from fulfillment_locations where id=$1 and code=$2 and is_active=true`, [WAREHOUSE_ID, WAREHOUSE_CODE]),
    db.query(`select email from portal_vendor_access
                where account_name=$1 and is_active=true order by id`, [ACCOUNT]),
    db.query(`select lower(email) email,notification_type,is_subscribed
                from customer_email_preferences
               where account_name=$1 and notification_type in ($2,'RECEIPT_CONFIRMATION','INBOUND_RECEIVED','*')`,
      [ACCOUNT, EMAIL_TYPE]),
  ]);
  if (account.rowCount !== 1 || warehouse.rowCount !== 1) throw new Error("Receipt email scope could not be verified.");
  const owner = account.rows[0];
  const customerRecipients = normalizedEmails([
    owner.email, owner.portal_login_email, owner.billing_email, owner.ap_email,
    ...contacts.rows.map((row) => row.email),
  ]).filter((email) => email !== SYSTEM_EMAIL);
  const warehouseOrders = normalizedEmails([warehouse.rows[0].billing_contact_email]);
  if (customerRecipients.length !== 1) throw new Error("Expected exactly one active Rancher's receipt-confirmation recipient.");
  if (warehouseOrders.length !== 1) throw new Error("Expected exactly one configured Grey Wolf Orders recipient.");
  const blocked = new Set(preferences.rows.filter((row) => row.is_subscribed === false).map((row) => row.email));
  if (blocked.has("*") || blocked.has(customerRecipients[0]) || blocked.has(warehouseOrders[0])) {
    throw new Error("A receipt-confirmation recipient is opted out.");
  }
  return { to: customerRecipients, cc: warehouseOrders };
}

async function sendConfirmation(db, inbound, recipients) {
  const existing = await db.query(
    "select id,status,message_id from email_delivery_log where delivery_key=$1 limit 1",
    [DELIVERY_KEY]
  );
  if (existing.rows[0]?.status === "SENT") {
    return { sent: true, duplicatePrevented: true, providerAccepted: true,
      messageId: existing.rows[0].message_id || "" };
  }
  if (!process.env.RESEND_API_KEY) throw new Error("The production email provider is not configured.");
  const subject = `Inbound Received - ${inbound.inboundCode} - Rancher's Chips`;
  const text = [
    "Hello Rancher's Chips team,",
    "",
    `Inbound ${inbound.inboundCode} has been received and put away at Grey Wolf 3PL - Mississauga.`,
    "",
    `Received date: November 5, 2026`,
    `Origin: Ranchers Chips NY / Remix Logistics`,
    `Pallets: ${PALLETS}`,
    `Product: Rancher's Tallow Chips - 4 oz`,
    `Received: ${CASES} cases (${RECEIVED_UNITS.toLocaleString("en-US")} bags; ${UNITS_PER_CASE} bags per case)`,
    `Lot: ${LOT}`,
    `Best-by date: March 2, 2027`,
    "",
    "The inventory is available for picking and shipping.",
    "",
    "Regards,",
    "WMS365 Support",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55">
<p>Hello Rancher's Chips team,</p>
<p>Inbound <strong>${inbound.inboundCode}</strong> has been received and put away at Grey Wolf 3PL - Mississauga.</p>
<table style="border-collapse:collapse;width:100%;max-width:720px">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Received date</td><td style="padding:8px;border:1px solid #d9e2e8">November 5, 2026</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Origin</td><td style="padding:8px;border:1px solid #d9e2e8">Ranchers Chips NY / Remix Logistics</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Pallets</td><td style="padding:8px;border:1px solid #d9e2e8">${PALLETS}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Product</td><td style="padding:8px;border:1px solid #d9e2e8">Rancher's Tallow Chips - 4 oz</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Quantity</td><td style="padding:8px;border:1px solid #d9e2e8">${CASES} cases (${RECEIVED_UNITS.toLocaleString("en-US")} bags; ${UNITS_PER_CASE} bags per case)</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Lot</td><td style="padding:8px;border:1px solid #d9e2e8">${LOT}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Best-by date</td><td style="padding:8px;border:1px solid #d9e2e8">March 2, 2027</td></tr>
</table>
<p>The inventory is available for picking and shipping.</p>
<p>Regards,<br>WMS365 Support</p>
</body></html>`;
  const attachment = buildPortalInboundReceiptPdfAttachment(inbound);
  const log = await db.query(
    `insert into email_delivery_log (
       status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
       subject,account_name,source_type,source_ref,delivery_key,metadata
     ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,$2::jsonb,'[]'::jsonb,
               $3,$4,$5,$6,$7,$8,$9::jsonb)
     on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,updated_at=now()
     returning id`,
    [JSON.stringify(recipients.to), JSON.stringify(recipients.cc), SYSTEM_EMAIL, subject,
      ACCOUNT, EMAIL_TYPE, inbound.inboundCode, DELIVERY_KEY,
      JSON.stringify({ reference: REFERENCE, receivedDate: RECEIVED_DATE, palletCount: PALLETS,
        receivedCases: CASES, receivedUnits: RECEIVED_UNITS, lot: LOT, expiry: EXPIRY,
        addressingPolicy: "CUSTOMER_TO_WAREHOUSE_ORDERS_CC" })]
  );
  const logId = log.rows[0].id;
  try {
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": DELIVERY_KEY,
      },
      body: JSON.stringify({
        from: "WMS365 <support@wms365.co>", to: recipients.to, cc: recipients.cc, bcc: [],
        reply_to: SYSTEM_EMAIL, subject, text, html,
        attachments: [{ filename: attachment.filename, content: attachment.content.toString("base64") }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
    await db.query(
      `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
              sent_at=now(),updated_at=now() where id=$1`,
      [logId, payload.id, "Resend accepted the Rancher's inbound receipt confirmation with Grey Wolf Orders in CC."]
    );
    return { sent: true, duplicatePrevented: false, providerAccepted: true, messageId: payload.id };
  } catch (error) {
    await db.query(
      `update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
      [logId, String(error.message || error).slice(0, 2000)]
    ).catch(() => {});
    throw error;
  }
}

async function main() {
  if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
    || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
    || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
    throw new Error("Production Railway identity does not match the pinned WMS365 application.");
  }
  const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  let committed = false;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);
    const localDate = (await client.query("select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') value")).rows[0].value;
    if (localDate !== RECEIVED_DATE) throw new Error(`Eastern date changed to ${localDate}; stop before posting with a stale date.`);
    const account = await client.query("select id,is_active from owner_accounts where name=$1 for update", [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error("Exact active Rancher's account verification failed.");
    }
    const warehouse = await client.query(
      `select fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
         from fulfillment_locations fl join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=$2`,
      [ACCOUNT, WAREHOUSE_ID]
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || wh.code !== WAREHOUSE_CODE || !wh.is_active
      || !wh.allow_inbound || !wh.allow_outbound || !wh.allow_storage) {
      throw new Error("Rancher's warehouse assignment verification failed.");
    }
    const item = await client.query(
      `select sku,description,upc,tracking_level,unit_uom,units_per_case,lot_tracked,
              expiration_tracked,blocked,item_type from item_catalog
        where account_name=$1 and sku=$2 for update`, [ACCOUNT, SKU]
    );
    const product = item.rows[0];
    if (item.rowCount !== 1 || product.upc !== UPC || product.tracking_level !== "UNIT"
      || product.unit_uom !== "EA" || Number(product.units_per_case) !== UNITS_PER_CASE
      || !product.lot_tracked || !product.expiration_tracked || product.blocked
      || product.item_type !== "INVENTORY") {
      throw new Error("Rancher's active tallow-chip item definition changed.");
    }
    const bin = await client.query(
      `select account_name,fulfillment_location_id,location_type,is_pickable
         from bin_locations where code=$1 for update`, [LOCATION]
    );
    const destination = bin.rows[0];
    if (bin.rowCount !== 1 || destination.account_name !== ACCOUNT
      || Number(destination.fulfillment_location_id) !== WAREHOUSE_ID
      || destination.location_type !== "STORAGE" || !destination.is_pickable) {
      throw new Error("Rancher's dedicated pickable bulk location verification failed.");
    }
    const duplicate = await client.query(
      `select inbound_code,status from portal_inbounds
        where account_name=$1 and (reference_number=$2 or notes ilike '%091026%') for update`,
      [ACCOUNT, REFERENCE]
    );
    if (duplicate.rowCount) throw new Error(`Possible duplicate receipt: ${duplicate.rows.map((row) => `${row.inbound_code} (${row.status})`).join(", ")}`);
    const before = Number((await client.query(
      `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
        where account_name=$1 and sku=$2 and location=$3 and lot_number=$4 and expiration_date=$5`,
      [ACCOUNT, SKU, LOCATION, LOT, EXPIRY]
    )).rows[0].quantity);
    const notes = [
      "Received from Ranchers Chips NY via Remix Logistics.",
      "Origin: 1130 Military Rd, Tonawanda, NY 14217.",
      `${PALLETS} pallets; ${CASES} cases; ${UNITS_PER_CASE} bags per case; ${RECEIVED_UNITS} bags total.`,
      `Printed lot code ${LOT}; best-by ${EXPIRY}.`,
      "No pallet-level case split was supplied; the two equal pallet allocations record the verified total only.",
    ].join(" ");
    let inbound = await savePortalInboundForAccount(client, ACCOUNT, {
      fulfillmentLocationId: WAREHOUSE_ID,
      referenceNumber: REFERENCE,
      carrierName: "Remix Logistics",
      expectedDate: RECEIVED_DATE,
      contactName: "Ranchers Chips NY",
      notes,
      lines: [{ sku: SKU, quantity: RECEIVED_UNITS }],
    }, {
      activityTitlePrefix: "warehouse",
      activityActor: ACTOR.full_name,
      creatorEmail: ACTOR.email,
      taskAppUser: ACTOR,
    });
    await client.query(
      `update portal_inbound_lines set pallet_count=$2,lot_number=$3,expiration_date=$4::date
        where inbound_id=$1`, [inbound.id, PALLETS, LOT, EXPIRY]
    );
    inbound = await updateAdminPortalInboundStatus(client, inbound.id, "ARRIVED", ACTOR, {
      note: `${PALLETS} pallets received from Remix Logistics on ${RECEIVED_DATE}.`,
    });
    const line = inbound.lines.find((entry) => entry.sku === SKU);
    inbound = await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", ACTOR, {
      receivingLocation: LOCATION,
      receivingLines: [1, 2].map((palletNumber) => ({
        id: line.id,
        sku: SKU,
        receivedQuantity: UNITS_PER_PALLET,
        receivedLocation: LOCATION,
        lotNumber: LOT,
        expirationDate: EXPIRY,
        palletReference: `${REFERENCE}-P${palletNumber}`,
        palletSizeType: "STANDARD",
      })),
      note: `Received ${CASES} cases (${RECEIVED_UNITS} bags) across ${PALLETS} pallets; lot ${LOT}; best-by ${EXPIRY}.`,
    });
    inbound = await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
      note: `Inventory is stored at ${LOCATION} and available for allocation.`,
    });
    await client.query(
      `update portal_inbounds set arrived_at=$2::date + time '12:00',received_at=$2::date + time '12:00',updated_at=now()
        where id=$1`, [inbound.id, RECEIVED_DATE]
    );
    const head = (await client.query(
      `select id,inbound_code,account_name,status,reference_number,carrier_name,
              expected_date::text,received_at,fulfillment_location_id,notes
         from portal_inbounds where id=$1`, [inbound.id]
    )).rows[0];
    const lines = (await client.query(
      `select sku,expected_quantity,received_quantity,received_location,lot_number,expiration_date::text,pallet_count
         from portal_inbound_lines where inbound_id=$1`, [inbound.id]
    )).rows;
    const allocations = (await client.query(
      `select allocation_number,quantity,location,lot_number,expiration_date::text,pallet_reference
         from portal_inbound_receipt_allocations where inbound_id=$1 order by allocation_number`, [inbound.id]
    )).rows;
    const ledger = (await client.query(
      `select coalesce(sum(quantity_delta),0)::integer quantity from inventory_transactions
        where source_type='PORTAL_INBOUND' and source_id=$1::text and account_name=$2 and sku=$3`,
      [String(inbound.id), ACCOUNT, SKU]
    )).rows[0];
    const after = Number((await client.query(
      `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
        where account_name=$1 and sku=$2 and location=$3 and lot_number=$4 and expiration_date=$5`,
      [ACCOUNT, SKU, LOCATION, LOT, EXPIRY]
    )).rows[0].quantity);
    const saved = lines[0];
    if (head.account_name !== ACCOUNT || head.status !== "PUTAWAY_COMPLETE" || head.reference_number !== REFERENCE
      || head.carrier_name !== "Remix Logistics" || head.expected_date !== RECEIVED_DATE
      || String(head.fulfillment_location_id) !== String(WAREHOUSE_ID)
      || new Date(head.received_at).toISOString().slice(0, 10) !== RECEIVED_DATE
      || lines.length !== 1 || saved.sku !== SKU
      || Number(saved.expected_quantity) !== RECEIVED_UNITS || Number(saved.received_quantity) !== RECEIVED_UNITS
      || saved.received_location !== LOCATION || saved.lot_number !== LOT || saved.expiration_date !== EXPIRY
      || Number(saved.pallet_count) !== PALLETS || allocations.length !== PALLETS
      || allocations.some((entry) => Number(entry.quantity) !== UNITS_PER_PALLET || entry.location !== LOCATION
        || entry.lot_number !== LOT || entry.expiration_date !== EXPIRY || !entry.pallet_reference)
      || Number(ledger.quantity) !== RECEIVED_UNITS || after - before !== RECEIVED_UNITS) {
      throw new Error("Post-receipt inventory, lot, pallet, or ledger verification failed.");
    }
    const result = {
      outcome: APPLY ? "created_received_and_available" : "dry_run_rolled_back",
      applied: APPLY,
      inbound: head.inbound_code,
      status: head.status,
      account: ACCOUNT,
      warehouse: WAREHOUSE_CODE,
      receivedDate: RECEIVED_DATE,
      carrier: head.carrier_name,
      sku: SKU,
      upc: UPC,
      cases: CASES,
      receivedUnits: RECEIVED_UNITS,
      pallets: PALLETS,
      lot: LOT,
      expiry: EXPIRY,
      pickableLocation: LOCATION,
      inventoryIncrease: after - before,
      billingEventsCreated: Array.isArray(inbound.billingEventsCreated) ? inbound.billingEventsCreated.length : 0,
    };
    if (APPLY) {
      await client.query("commit");
      committed = true;
    } else {
      await client.query("rollback");
      console.log(JSON.stringify({ ...result, email: { ready: true, sent: false, toCount: 1, ccCount: 1 } }));
      return;
    }
    const pool = new Pool({ connectionString, ssl: false });
    try {
      const recipients = await loadAndValidateRecipients(pool);
      const fullInbound = await (async () => {
        const { rows } = await pool.query("select id from portal_inbounds where inbound_code=$1 and account_name=$2", [head.inbound_code, ACCOUNT]);
        if (rows.length !== 1) throw new Error("Committed inbound could not be reloaded for confirmation.");
        const receiptRows = await pool.query(
          `select i.*,fl.code fulfillment_location_code,fl.name fulfillment_location_name
             from portal_inbounds i join fulfillment_locations fl on fl.id=i.fulfillment_location_id where i.id=$1`, [rows[0].id]
        );
        const receiptLines = await pool.query(
          `select l.*,c.description,c.tracking_level from portal_inbound_lines l
             left join item_catalog c on c.account_name=$2 and c.sku=l.sku where l.inbound_id=$1 order by l.line_number`,
          [rows[0].id, ACCOUNT]
        );
        const receiptAllocations = await pool.query(
          `select line_id,quantity received_quantity,location,lot_number,expiration_date::text,pallet_reference
             from portal_inbound_receipt_allocations where inbound_id=$1 order by allocation_number`, [rows[0].id]
        );
        return {
          id: receiptRows.rows[0].id,
          inboundCode: receiptRows.rows[0].inbound_code,
          accountName: receiptRows.rows[0].account_name,
          status: receiptRows.rows[0].status,
          referenceNumber: receiptRows.rows[0].reference_number,
          carrierName: receiptRows.rows[0].carrier_name,
          expectedDate: receiptRows.rows[0].expected_date?.toISOString?.().slice(0, 10) || RECEIVED_DATE,
          receivedAt: receiptRows.rows[0].received_at,
          fulfillmentLocationCode: receiptRows.rows[0].fulfillment_location_code,
          fulfillmentLocationName: receiptRows.rows[0].fulfillment_location_name,
          lines: receiptLines.rows.map((row) => ({
            id: row.id, sku: row.sku, description: row.description, trackingLevel: row.tracking_level,
            quantity: Number(row.expected_quantity), receivedQuantity: Number(row.received_quantity),
            receiptAllocations: receiptAllocations.rows.filter((entry) => String(entry.line_id) === String(row.id)).map((entry) => ({
              receivedQuantity: Number(entry.received_quantity), location: entry.location,
              lotNumber: entry.lot_number, expirationDate: entry.expiration_date,
              palletReference: entry.pallet_reference,
            })),
          })),
          receiptPalletSummary: { totalPallets: PALLETS },
        };
      })();
      const email = await sendConfirmation(pool, fullInbound, recipients);
      console.log(JSON.stringify({ ...result, email: { ...email, toCount: recipients.to.length, ccCount: recipients.cc.length } }));
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (!committed) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
