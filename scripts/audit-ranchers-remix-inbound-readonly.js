"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const REFERENCE = "RANCHERS-NY-REMIX-20261105-2PAL-128CS";
const SKU = "RTC-4OZ-EA";
const UPC = "199284767607";
const LOCATION = "GW3PL-MISS-RANCH-BULK";

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "").trim().toLowerCase()).digest("hex").slice(0, 12);
}

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  try {
    const [scope, item, bin, duplicates, account, contacts, preferences, emailLog] = await Promise.all([
      db.query(`select oa.id account_id,oa.name,oa.is_active,fl.id warehouse_id,fl.code warehouse_code,
                       fl.name warehouse_name,fl.is_active warehouse_active,fl.billing_contact_email,
                       cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
                  from owner_accounts oa
                  join company_fulfillment_locations cfl on cfl.account_name=oa.name
                  join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where oa.name=$1 and fl.id=1`, [ACCOUNT]),
      db.query(`select sku,description,upc,tracking_level,unit_uom,units_per_case,
                       lot_tracked,expiration_tracked,blocked,item_type
                  from item_catalog where account_name=$1 and sku=$2`, [ACCOUNT, SKU]),
      db.query(`select code,account_name,fulfillment_location_id,location_type,is_pickable
                  from bin_locations where code=$1`, [LOCATION]),
      db.query(`select inbound_code,status,reference_number,received_at
                  from portal_inbounds
                 where account_name=$1 and (reference_number=$2 or notes ilike '%091026%')
                 order by id`, [ACCOUNT, REFERENCE]),
      db.query(`select email,portal_login_email,billing_email,ap_email
                  from owner_accounts where name=$1`, [ACCOUNT]),
      db.query(`select email,is_active from portal_vendor_access where account_name=$1 order by id`, [ACCOUNT]),
      db.query(`select email,notification_type,is_subscribed
                  from customer_email_preferences
                 where account_name=$1 and notification_type in ('PORTAL_INBOUND','RECEIPT_CONFIRMATION','INBOUND_RECEIVED','*')`, [ACCOUNT]),
      db.query(`select status,message_id,to_addresses,cc_addresses,bcc_addresses
                  from email_delivery_log where delivery_key=$1`, [`RANCHERS-INBOUND-RECEIVED:${REFERENCE}`]),
    ]);
    const row = scope.rows[0] || {};
    const customerEmails = [account.rows[0]?.email, account.rows[0]?.portal_login_email,
      account.rows[0]?.billing_email, account.rows[0]?.ap_email,
      ...contacts.rows.filter((entry) => entry.is_active).map((entry) => entry.email)]
      .filter(Boolean);
    console.log(JSON.stringify({
      mode: "READ_ONLY",
      localDate: (await db.query("select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') value")).rows[0].value,
      scope: { accountId: row.account_id, account: row.name, accountActive: row.is_active,
        warehouseId: row.warehouse_id, warehouseCode: row.warehouse_code,
        warehouseName: row.warehouse_name, warehouseActive: row.warehouse_active,
        allowInbound: row.allow_inbound, allowOutbound: row.allow_outbound, allowStorage: row.allow_storage,
        warehouseOrdersRecipientConfigured: Boolean(row.billing_contact_email),
        warehouseOrdersRecipientFingerprint: fingerprint(row.billing_contact_email) },
      item: item.rows,
      bin: bin.rows,
      duplicates: duplicates.rows,
      customerRecipientCount: new Set(customerEmails.map((value) => value.toLowerCase())).size,
      customerRecipientFingerprints: [...new Set(customerEmails.map(fingerprint))],
      preferences: preferences.rows.map((entry) => ({
        recipient: entry.email === "*" ? "*" : fingerprint(entry.email),
        notificationType: entry.notification_type,
        subscribed: entry.is_subscribed,
      })),
      existingEmail: emailLog.rows.map((entry) => ({ status: entry.status, messageIdPresent: Boolean(entry.message_id),
        toCount: Array.isArray(entry.to_addresses) ? entry.to_addresses.length : 0,
        ccCount: Array.isArray(entry.cc_addresses) ? entry.cc_addresses.length : 0,
        bccCount: Array.isArray(entry.bcc_addresses) ? entry.bcc_addresses.length : 0 })),
      expected: { reference: REFERENCE, sku: SKU, upc: UPC, cases: 128, unitsPerCase: 12,
        receivedUnits: 1536, pallets: 2, lot: "091026", expiry: "2027-03-02", location: LOCATION },
    }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
