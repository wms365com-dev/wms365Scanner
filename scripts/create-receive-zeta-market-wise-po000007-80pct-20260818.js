"use strict";

const { Client } = require("pg");
const { APP_USER_ROLES, savePortalInboundForAccount, updateAdminPortalInboundStatus } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const ACCOUNT_ID = "1566";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const LOCATION = "GW3PL-MISS-ZETA-BULK";
const REFERENCE = "PO000007-MARKET-WISE-80PCT";
const RECEIVED_DATE = "2026-08-18";
const LINES = [
  { sku: "S158", quantity: 88 },
  { sku: "S159", quantity: 89 },
  { sku: "S160", quantity: 198 },
  { sku: "S161", quantity: 273 },
  { sku: "S162", quantity: 183 },
  { sku: "S163", quantity: 80 },
  { sku: "S164", quantity: 34 },
  { sku: "S165", quantity: 86 },
  { sku: "S166", quantity: 70 },
  { sku: "S566", quantity: 85 },
];
const TOTAL = 1186;
const ACTOR = {
  id: null,
  email: "operations@wms365.co",
  full_name: "WMS365 Owner-Approved Zeta Market Wise Transfer",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
  if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
    || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
    || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
    throw new Error("Production Railway identity does not match the pinned WMS365 application.");
  }
  if (LINES.reduce((sum, line) => sum + line.quantity, 0) !== TOTAL) throw new Error("Adjusted quantity total changed.");

  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);
    const account = await db.query("select id,is_active from owner_accounts where name=$1 for update", [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error("Exact active Zeta account verification failed.");
    }
    const warehouse = await db.query(
      `select fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
         from fulfillment_locations fl join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=$2`,
      [ACCOUNT, WAREHOUSE_ID],
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || wh.code !== WAREHOUSE_CODE || !wh.is_active
      || !wh.allow_inbound || !wh.allow_outbound || !wh.allow_storage) {
      throw new Error("Zeta Mississauga warehouse assignment verification failed.");
    }
    const bin = await db.query(
      `select account_name,fulfillment_location_id,location_type,is_pickable
         from bin_locations where code=$1 for update`, [LOCATION],
    );
    const destination = bin.rows[0];
    if (bin.rowCount !== 1 || destination.account_name !== ACCOUNT
      || Number(destination.fulfillment_location_id) !== WAREHOUSE_ID
      || destination.location_type !== "STORAGE" || !destination.is_pickable) {
      throw new Error("Zeta dedicated pickable bulk location verification failed.");
    }
    const duplicate = await db.query(
      `select inbound_code,status,reference_number from portal_inbounds
        where account_name=$1 and (
          upper(reference_number)=upper($2)
          or upper(coalesce(notes,'')) like '%PO000007%MARKET WISE%'
          or upper(coalesce(notes,'')) like '%ONEU0356410%MARKET WISE%'
        ) for update`,
      [ACCOUNT, REFERENCE],
    );
    if (duplicate.rowCount) {
      throw new Error(`Possible duplicate Market Wise PO000007 receipt: ${duplicate.rows.map((row) => `${row.inbound_code} (${row.status})`).join(", ")}`);
    }
    const catalog = await db.query(
      `select sku,tracking_level,blocked,item_type from item_catalog
        where account_name=$1 and sku=any($2::text[]) for update`,
      [ACCOUNT, LINES.map((line) => line.sku)],
    );
    const bySku = new Map(catalog.rows.map((row) => [row.sku, row]));
    for (const line of LINES) {
      const item = bySku.get(line.sku);
      if (!item || item.blocked || item.item_type !== "INVENTORY" || item.tracking_level !== "CASE") {
        throw new Error(`Item master verification failed for ${line.sku}.`);
      }
    }
    const before = new Map((await db.query(
      `select sku,coalesce(sum(quantity),0)::integer quantity from inventory_lines
        where account_name=$1 and location=$2 and sku=any($3::text[]) group by sku`,
      [ACCOUNT, LOCATION, LINES.map((line) => line.sku)],
    )).rows.map((row) => [row.sku, Number(row.quantity)]));

    const notes = [
      "Separate owner-confirmed transfer received from Market Wise on August 18, 2026.",
      "Pickup/source: Market Wise, 31 Lido Road, North York, ON M9M 1M7, 416-650-9322.",
      "Source document PO000007, container ONEU0356410, invoice HHGW-2605408.",
      "Owner instructed WMS365 to exclude both free carpet rolls and receive 80% of each product line.",
      "Each source carton quantity was multiplied by 80% and rounded to the nearest whole case; 1,186 cases total.",
    ].join(" ");
    let inbound = await savePortalInboundForAccount(db, ACCOUNT, {
      fulfillmentLocationId: WAREHOUSE_ID,
      referenceNumber: REFERENCE,
      carrierName: "Market Wise Transfer",
      expectedDate: RECEIVED_DATE,
      contactName: "Market Wise",
      notes,
      lines: LINES,
    }, {
      activityTitlePrefix: "warehouse",
      activityActor: ACTOR.full_name,
      creatorEmail: ACTOR.email,
      taskAppUser: ACTOR,
    });
    inbound = await updateAdminPortalInboundStatus(db, inbound.id, "ARRIVED", ACTOR, {
      note: `Adjusted PO000007 transfer arrived from Market Wise on ${RECEIVED_DATE}.`,
    });
    inbound = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
      receivingLocation: LOCATION,
      receivingLines: inbound.lines.map((line) => ({
        id: line.id,
        sku: line.sku,
        receivedQuantity: Number(line.expectedQuantity ?? line.quantity),
        receivedLocation: LOCATION,
      })),
      note: `Received 1,186 cases after the owner-approved 20% reduction; carpet rolls excluded.`,
    });
    inbound = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
      note: `Inventory put away at ${LOCATION} and available for allocation.`,
    });
    const effectiveTimestamp = `${RECEIVED_DATE} 12:00:00-04`;
    await db.query(
      `update portal_inbounds set arrived_at=$2::timestamptz,received_at=$2::timestamptz,updated_at=now()
        where id=$1`, [inbound.id, effectiveTimestamp],
    );
    const head = (await db.query(
      `select inbound_code,account_name,status,reference_number,carrier_name,expected_date::text,
              received_at::text,fulfillment_location_id from portal_inbounds where id=$1`, [inbound.id],
    )).rows[0];
    const savedLines = (await db.query(
      `select sku,expected_quantity,received_quantity,received_location
         from portal_inbound_lines where inbound_id=$1 order by line_number`, [inbound.id],
    )).rows;
    const ledger = new Map((await db.query(
      `select sku,sum(quantity_delta)::integer quantity from inventory_transactions
        where source_type='PORTAL_INBOUND' and source_id=$1::text group by sku`, [inbound.id],
    )).rows.map((row) => [row.sku, Number(row.quantity)]));
    const after = new Map((await db.query(
      `select sku,coalesce(sum(quantity),0)::integer quantity from inventory_lines
        where account_name=$1 and location=$2 and sku=any($3::text[]) group by sku`,
      [ACCOUNT, LOCATION, LINES.map((line) => line.sku)],
    )).rows.map((row) => [row.sku, Number(row.quantity)]));
    const savedBySku = new Map(savedLines.map((row) => [row.sku, row]));
    for (const line of LINES) {
      const saved = savedBySku.get(line.sku);
      if (!saved || Number(saved.expected_quantity) !== line.quantity || Number(saved.received_quantity) !== line.quantity
        || saved.received_location !== LOCATION || ledger.get(line.sku) !== line.quantity
        || (after.get(line.sku) || 0) - (before.get(line.sku) || 0) !== line.quantity) {
        throw new Error(`Post-receipt verification failed for ${line.sku}.`);
      }
    }
    if (head.account_name !== ACCOUNT || head.status !== "PUTAWAY_COMPLETE" || head.reference_number !== REFERENCE
      || head.carrier_name !== "Market Wise Transfer" || head.expected_date !== RECEIVED_DATE
      || Number(head.fulfillment_location_id) !== WAREHOUSE_ID || savedLines.length !== 10
      || savedLines.reduce((sum, row) => sum + Number(row.received_quantity), 0) !== TOTAL) {
      throw new Error("Final inbound scope or quantity verification failed.");
    }
    const result = {
      outcome: APPLY ? "created_received_and_putaway" : "dry_run_rolled_back",
      applied: APPLY,
      inbound: head.inbound_code,
      account: ACCOUNT,
      warehouse: WAREHOUSE_CODE,
      status: head.status,
      reference: head.reference_number,
      receivedDate: RECEIVED_DATE,
      lineCount: savedLines.length,
      casesReceived: TOTAL,
      carpetRollsExcluded: 2,
      location: LOCATION,
      billingEventsCreated: Array.isArray(inbound.billingEventsCreated) ? inbound.billingEventsCreated.length : 0,
    };
    if (APPLY) await db.query("commit");
    else await db.query("rollback");
    console.log(JSON.stringify(result));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
