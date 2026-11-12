"use strict";

const { Client } = require("pg");
const { APP_USER_ROLES, getPortalInventorySummary, upsertInventoryLine } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "PURE FOODS BY ESTEE";
const ACCOUNT_ID = "1";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const EFFECTIVE_DATE = "2026-11-06";
const ITEMS = [{ sku: "170", quantity: 900 }, { sku: "268", quantity: 64 }];
const RUN_KEY = "PURE-FOODS-POSITIVE-ADJUSTMENT-170-268-20261106";
const DELIVERY_KEY = `${RUN_KEY}:CUSTOMER-CONFIRMATION`;
const NOTIFICATION_TYPE = "INVENTORY_AVAILABLE";
const SYSTEM_TO = "support@wms365.co";
const ACTOR = {
  id: null,
  email: "operations@wms365.co",
  full_name: "WMS365 Owner-Approved Inventory Adjustment",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const adjustmentKey = (sku, location) => `${RUN_KEY}:${sku}:${location}`;

async function facts(db, lock = false) {
  const account = await db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
  if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) throw new Error("Pure Foods account identity mismatch.");
  const warehouse = await db.query(
    `select fl.id,fl.code,fl.is_active,cfl.allow_storage,cfl.customer_portal_visible
       from fulfillment_locations fl join company_fulfillment_locations cfl
         on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
      where fl.id=$2 and fl.code=$3`, [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
  );
  const wh = warehouse.rows[0];
  if (warehouse.rowCount !== 1 || !wh.is_active || !wh.allow_storage || !wh.customer_portal_visible) throw new Error("Pure Foods Mississauga warehouse assignment mismatch.");

  const rows = [];
  for (const request of ITEMS) {
    const item = await db.query(
      `select sku,description,upc,tracking_level,uom_label,unit_uom,units_per_case,item_type,blocked
         from item_catalog where account_name=$1 and sku=$2 ${lock ? "for update" : ""}`,
      [ACCOUNT, request.sku]
    );
    const catalog = item.rows[0];
    const expectedUnitsPerCase = request.sku === "268" ? 12 : 1;
    const needsCatalogCorrection = request.sku === "268" && catalog?.tracking_level === "UNIT"
      && !catalog?.unit_uom && catalog?.units_per_case == null;
    if (item.rowCount !== 1 || catalog.blocked || catalog.item_type !== "INVENTORY"
        || (!needsCatalogCorrection && (catalog.tracking_level !== "CASE"
          || !["", "CASE"].includes(catalog.unit_uom) || Number(catalog.units_per_case) !== expectedUnitsPerCase))) {
      throw new Error(`Pure Foods item ${request.sku} identity or case configuration mismatch: ${JSON.stringify(catalog || null)}.`);
    }
    const inventory = await db.query(
      `select i.*,b.location_type,b.is_pickable,b.fulfillment_location_id
         from inventory_lines i join bin_locations b on b.code=i.location and b.account_name=i.account_name
        where i.account_name=$1 and i.sku=$2 and i.lot_number='' and i.expiration_date=''
          and b.fulfillment_location_id=$3 and b.location_type='STORAGE' and b.is_pickable=true
        order by i.quantity desc,i.id asc ${lock ? "for update of i,b" : ""}`,
      [ACCOUNT, request.sku, WAREHOUSE_ID]
    );
    let line = inventory.rows[0];
    if (!line) {
      const fallback = await db.query(
        `select b.code as location,b.location_type,b.is_pickable,b.fulfillment_location_id,0::numeric as quantity,
                null::bigint as id,''::text as lot_number,''::text as expiration_date
           from bin_locations b
          where b.account_name=$1 and b.fulfillment_location_id=$2 and b.location_type='STORAGE'
            and b.is_pickable=true and b.code in ('GW3PL-MISS-PUREFOODS-BULK','WHS01-PUREFOODS-BULK')
          order by case when b.code='GW3PL-MISS-PUREFOODS-BULK' then 0 else 1 end limit 1`,
        [ACCOUNT, WAREHOUSE_ID]
      );
      line = fallback.rows[0];
    }
    if (!line) throw new Error(`No established pickable Pure Foods Mississauga bulk bin is available for SKU ${request.sku}.`);
    const key = adjustmentKey(request.sku, line.location);
    const prior = await db.query(
      "select id,quantity_delta,quantity_before,quantity_after from inventory_transactions where idempotency_key=$1",
      [key]
    );
    const totals = await db.query(
      `select coalesce(sum(i.quantity),0)::numeric on_hand,
              coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                join portal_orders o on o.id=a.order_id
               where o.account_name=$1 and o.fulfillment_location_id=$3 and a.sku=$2
                 and o.status in ('RELEASED','PICKING','PICKED','STAGED')),0)::numeric reserved
         from inventory_lines i join bin_locations b on b.code=i.location
        where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=$3`,
      [ACCOUNT, request.sku, WAREHOUSE_ID]
    );
    rows.push({ request, catalog, expectedUnitsPerCase, needsCatalogCorrection, line, prior: prior.rows[0] || null,
      onHand: Number(totals.rows[0].on_hand), reserved: Number(totals.rows[0].reserved), key });
  }
  return rows;
}

async function sendNotice(db, verifiedRows) {
  const existing = await db.query(
    "select id,status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where delivery_key=$1",
    [DELIVERY_KEY]
  );
  if (existing.rows[0]?.status === "SENT") return { sent: true, duplicatePrevented: true, recipientCount: existing.rows[0].bcc_addresses.length };
  if (!process.env.RESEND_API_KEY) throw new Error("Production email provider is unavailable; inventory was adjusted but notice was not sent.");
  const [contacts, preferences] = await Promise.all([
    db.query("select email from portal_vendor_access where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>'' order by id", [ACCOUNT]),
    db.query("select lower(email) email,is_subscribed from customer_email_preferences where account_name=$1 and notification_type in ($2,'*')", [ACCOUNT, NOTIFICATION_TYPE]),
  ]);
  const optedOut = new Set(preferences.rows.filter((row) => row.is_subscribed === false).map((row) => normalizeEmail(row.email)));
  const recipients = [...new Set(contacts.rows.map((row) => normalizeEmail(row.email)).filter(Boolean))]
    .filter((email) => !optedOut.has(email) && !optedOut.has("*"));
  if (!recipients.length) throw new Error("No subscribed Pure Foods portal contacts are available for the inventory notice.");
  const detailLines = verifiedRows.map((row) => `SKU ${row.sku}: +${row.quantityAdded} cases (on hand ${row.onHand}, available ${row.available})`);
  const subject = "Inventory Adjustment Confirmed - Pure Foods - November 6, 2026";
  const text = ["Hello Pure Foods team,", "", "The following positive inventory adjustments have been completed at the Mississauga warehouse, effective November 6, 2026:", "", ...detailLines, "", "Regards,", "WMS365 Support"].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px"><p>Hello Pure Foods team,</p><p>The following positive inventory adjustments have been completed at the <strong>Mississauga warehouse</strong>, effective <strong>November 6, 2026</strong>:</p><ul>${verifiedRows.map((row) => `<li><strong>SKU ${row.sku}</strong>: +${row.quantityAdded} cases (on hand ${row.onHand}, available ${row.available})</li>`).join("")}</ul><p>Regards,<br>WMS365 Support</p></div>`;
  const log = await db.query(
    `insert into email_delivery_log (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
       account_name,source_type,source_ref,delivery_key,metadata)
     values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8,$9::jsonb)
     on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,to_addresses=excluded.to_addresses,
       cc_addresses='[]'::jsonb,bcc_addresses=excluded.bcc_addresses,updated_at=now() returning id`,
    [JSON.stringify([SYSTEM_TO]), JSON.stringify(recipients), SYSTEM_TO, subject, ACCOUNT, NOTIFICATION_TYPE,
      ITEMS.map((row) => row.sku).join(","), DELIVERY_KEY, JSON.stringify({ warehouseCode: WAREHOUSE_CODE, effectiveDate: EFFECTIVE_DATE, adjustments: verifiedRows, addressing: "BCC_ONLY" })]
  );
  try {
    const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": DELIVERY_KEY },
      body: JSON.stringify({ from: "WMS365 <support@wms365.co>", to: [SYSTEM_TO], cc: [], bcc: recipients, reply_to: SYSTEM_TO, subject, text, html }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
    await db.query("update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1",
      [log.rows[0].id, payload.id, "Resend accepted the BCC-only Pure Foods inventory adjustment confirmation."]);
    return { sent: true, providerAccepted: true, recipientCount: recipients.length };
  } catch (error) {
    await db.query("update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1",
      [log.rows[0].id, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin read only");
    const before = await facts(db);
    await db.query("rollback");
    console.log(JSON.stringify({ phase: "preflight", account: ACCOUNT, warehouse: WAREHOUSE_CODE, effectiveDate: EFFECTIVE_DATE,
      items: before.map((row) => ({ sku: row.request.sku, quantityToAdd: row.request.quantity, location: row.line.location,
        currentBinQuantity: Number(row.line.quantity), onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved,
        trackingLevel: row.catalog.tracking_level, unitsPerCase: row.catalog.units_per_case,
        needsCatalogCorrection: row.needsCatalogCorrection, alreadyApplied: Boolean(row.prior) })) }, null, 2));
    if (!APPLY) return;

    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [RUN_KEY]);
    const current = await facts(db, true);
    for (const row of current) {
      if (row.needsCatalogCorrection) {
        if (row.onHand !== 0 || row.reserved !== 0) throw new Error(`SKU ${row.request.sku} has existing unit-based stock or allocations; case conversion requires reconciliation.`);
        const corrected = await db.query(
          `update item_catalog set tracking_level='CASE',unit_uom='CASE',units_per_case=$3,updated_at=now()
            where account_name=$1 and sku=$2 and tracking_level='UNIT' and coalesce(unit_uom,'')='' and units_per_case is null
            returning sku,tracking_level,unit_uom,units_per_case`,
          [ACCOUNT, row.request.sku, row.expectedUnitsPerCase]
        );
        if (corrected.rowCount !== 1) throw new Error(`SKU ${row.request.sku} item master changed before case conversion.`);
        await db.query("insert into activity_log(type,title,details) values('inventory',$1,$2)",
          [`Corrected Pure Foods SKU ${row.request.sku} case configuration`, `${ACCOUNT} | Tracking CASE | 12 units per case | Owner approved`]);
        row.catalog = { ...row.catalog, ...corrected.rows[0] };
      }
      if (row.prior) {
        if (Number(row.prior.quantity_delta) !== row.request.quantity) throw new Error(`Existing adjustment conflicts for SKU ${row.request.sku}.`);
        continue;
      }
      await upsertInventoryLine(db, {
        accountName: ACCOUNT, location: row.line.location, sku: row.request.sku, upc: row.catalog.upc || "",
        lotNumber: "", expirationDate: "", trackingLevel: "CASE", quantity: row.request.quantity,
      }, {
        transactionType: "ADJUSTMENT", sourceType: "OWNER_APPROVED_ADJUSTMENT", sourceId: RUN_KEY,
        fulfillmentLocationId: WAREHOUSE_ID, appUser: ACTOR, idempotencyKey: row.key, source: "web_admin",
        notes: `Owner-approved positive adjustment effective ${EFFECTIVE_DATE}: +${row.request.quantity} cases of SKU ${row.request.sku}.`,
      });
      await db.query("insert into activity_log(type,title,details) values('inventory',$1,$2)",
        [`Added ${row.request.quantity} cases of SKU ${row.request.sku} for Pure Foods`, `${ACCOUNT} | ${WAREHOUSE_CODE} | ${row.line.location} | +${row.request.quantity} cases | Effective ${EFFECTIVE_DATE} | Owner approved`]);
    }
    await db.query("commit");

    await db.query("begin read only");
    const after = await facts(db);
    const portal = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: WAREHOUSE_ID });
    await db.query("rollback");
    const verifiedRows = after.map((row) => {
      const original = before.find((entry) => entry.request.sku === row.request.sku);
      const portalItem = portal.find((entry) => entry.sku === row.request.sku);
      if (!row.prior || Number(row.prior.quantity_delta) !== row.request.quantity || row.onHand !== original.onHand + row.request.quantity
          || !portalItem || Number(portalItem.onHandQuantity) !== row.onHand || Number(portalItem.reservedQuantity) !== row.reserved) {
        throw new Error(`Post-adjustment verification failed for SKU ${row.request.sku}.`);
      }
      return { sku: row.request.sku, quantityAdded: row.request.quantity, location: row.line.location,
        onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved, pickable: row.line.is_pickable };
    });
    const email = await sendNotice(db, verifiedRows);
    const envelope = (await db.query("select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where delivery_key=$1", [DELIVERY_KEY])).rows[0];
    if (!envelope || envelope.status !== "SENT" || !envelope.message_id || envelope.to_addresses.length !== 1
        || envelope.to_addresses[0] !== SYSTEM_TO || envelope.cc_addresses.length !== 0 || envelope.bcc_addresses.length < 1) {
      throw new Error("BCC-only customer email verification failed.");
    }
    console.log(JSON.stringify({ phase: "verified", account: ACCOUNT, warehouse: WAREHOUSE_CODE, effectiveDate: EFFECTIVE_DATE,
      items: verifiedRows, emailStatus: envelope.status, providerAccepted: true, recipientCount: envelope.bcc_addresses.length,
      messageIdPresent: Boolean(envelope.message_id), duplicatePrevented: Boolean(email.duplicatePrevented) }, null, 2));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
