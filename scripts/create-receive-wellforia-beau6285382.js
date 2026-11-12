"use strict";

const { Client } = require("pg");
const {
  APP_USER_ROLES,
  savePortalInboundForAccount,
  updateAdminPortalInboundStatus,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const ACCOUNT_ID = "794";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const CONTAINER = "BEAU6285382";
const EXPECTED_DATE = "2026-10-02";
const RECEIVED_DATE = "2026-10-05";
const DESTINATION = "GW3PL-MISS-WELLFORIA-BULK";
const PALLET_COUNT = 45;
const LINES = [
  { sku: "WHOOPSIE-SMPL", description: "WHOOPSIE SAMPLES - 20CT", quantity: 60, unitsPerCase: 190 },
  { sku: "WW-12PK", description: "WHOOPSIE WIPES 12 PACK", quantity: 750, unitsPerCase: 4 },
];
const ACTOR = {
  id: null,
  email: "operations@wms365.co",
  full_name: "WMS365 Owner-Approved Wellforia Inbound",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let committed = false;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`wellforia-${CONTAINER}`]);
    const account = await db.query("select id, is_active from owner_accounts where name = $1", [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error("Wellforia account identity mismatch.");
    }
    const warehouse = await db.query(
      `select fl.code, fl.is_active, cfl.allow_inbound, cfl.allow_outbound, cfl.allow_storage
         from fulfillment_locations fl
         join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id = fl.id and cfl.account_name = $1
        where fl.id = $2`,
      [ACCOUNT, WAREHOUSE_ID]
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || wh.code !== WAREHOUSE_CODE || !wh.is_active
      || !wh.allow_inbound || !wh.allow_outbound || !wh.allow_storage) {
      throw new Error("Wellforia warehouse assignment mismatch.");
    }
    const destination = await db.query(
      `select code, account_name, fulfillment_location_id, location_type, is_pickable
         from bin_locations where code = $1 for update`,
      [DESTINATION]
    );
    const bin = destination.rows[0];
    if (destination.rowCount !== 1 || bin.account_name !== ACCOUNT
      || Number(bin.fulfillment_location_id) !== WAREHOUSE_ID
      || bin.location_type !== "STORAGE" || !bin.is_pickable) {
      throw new Error("Wellforia pickable bulk location mismatch.");
    }
    const duplicates = await db.query(
      `select inbound_code, status from portal_inbounds
        where account_name = $1 and (
          upper(reference_number) = upper($2)
          or upper(notes) like '%' || upper($2) || '%'
        ) order by id for update`,
      [ACCOUNT, CONTAINER]
    );
    if (duplicates.rowCount) {
      throw new Error(`Container already exists: ${duplicates.rows.map((row) => `${row.inbound_code} (${row.status})`).join(", ")}`);
    }
    const catalog = await db.query(
      `select sku, description, tracking_level, units_per_case, lot_tracked,
              expiration_tracked, item_type, blocked
         from item_catalog where account_name = $1 and sku = any($2::text[]) for update`,
      [ACCOUNT, LINES.map((line) => line.sku)]
    );
    const existing = new Map(catalog.rows.map((row) => [row.sku, row]));
    const ww = existing.get("WW-12PK");
    if (!ww || ww.description !== "WHOOPSIE WIPES 12 PACK" || ww.tracking_level !== "CASE"
      || Number(ww.units_per_case) !== 4 || ww.lot_tracked || ww.expiration_tracked
      || ww.item_type !== "INVENTORY" || ww.blocked) {
      throw new Error("WW-12PK catalog definition changed.");
    }
    if (existing.has("WHOOPSIE-SMPL")) {
      const sample = existing.get("WHOOPSIE-SMPL");
      if (sample.description !== "WHOOPSIE SAMPLES - 20CT" || sample.tracking_level !== "CASE"
        || Number(sample.units_per_case) !== 190 || sample.lot_tracked || sample.expiration_tracked
        || sample.item_type !== "INVENTORY" || sample.blocked) {
        throw new Error("Existing WHOOPSIE-SMPL catalog definition conflicts with the supplied inbound.");
      }
    } else {
      await db.query(
        `insert into item_catalog (
          account_name, sku, upc, description, tracking_level, uom_label, unit_uom,
          units_per_case, lot_tracked, expiration_tracked, item_type, item_category, blocked
        ) values ($1, 'WHOOPSIE-SMPL', '', 'WHOOPSIE SAMPLES - 20CT', 'CASE', 'cases', 'CASE',
          190, false, false, 'INVENTORY', 'Samples', false)`,
        [ACCOUNT]
      );
    }
    const before = {};
    for (const line of LINES) {
      const stock = await db.query(
        `select coalesce(sum(quantity), 0)::integer quantity
           from inventory_lines where account_name = $1 and location = $2 and sku = $3`,
        [ACCOUNT, DESTINATION, line.sku]
      );
      before[line.sku] = Number(stock.rows[0].quantity);
    }
    const notes = [
      `Container ${CONTAINER}.`,
      `${PALLET_COUNT} pallets total; floor-loaded.`,
      `Estimated delivery ${EXPECTED_DATE}; actual received date ${RECEIVED_DATE}.`,
      "WHOOPSIE-SMPL: 60 cartons, pack 190.",
      "WW-12PK: 750 cartons, pack 04.",
      "Pallet quantities by SKU were not supplied; no pallet split was inferred.",
    ].join(" ");
    let inbound = await savePortalInboundForAccount(db, ACCOUNT, {
      fulfillmentLocationId: WAREHOUSE_ID,
      referenceNumber: CONTAINER,
      carrierName: "",
      expectedDate: EXPECTED_DATE,
      contactName: "Wellforia Health Inc",
      notes,
      lines: LINES.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    }, {
      activityTitlePrefix: "warehouse",
      activityActor: ACTOR.full_name,
      creatorEmail: ACTOR.email,
      taskAppUser: ACTOR,
    });
    inbound = await updateAdminPortalInboundStatus(db, inbound.id, "ARRIVED", ACTOR, {
      note: `Container ${CONTAINER} arrived October 5, 2026 with 45 pallets.`,
    });
    inbound = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
      lines: inbound.lines.map((savedLine) => {
        const expected = LINES.find((line) => line.sku === savedLine.sku);
        return {
          id: savedLine.id,
          receivedQuantity: expected.quantity,
          receivedLocation: DESTINATION,
        };
      }),
      note: "Received in full from owner-supplied container details.",
    });
    if (!["RECEIVED_PENDING_PUTAWAY", "PUTAWAY_COMPLETE"].includes(inbound.status)) {
      throw new Error(`Receipt reached unexpected status ${inbound.status}.`);
    }
    if (inbound.status !== "PUTAWAY_COMPLETE") {
      inbound = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
        note: `All cartons recorded at ${DESTINATION}; inventory is pickable.`,
      });
    }
    await db.query(
      `update portal_inbounds
          set arrived_at = $2::date + time '12:00',
              received_at = $2::date + time '12:00', updated_at = now()
        where id = $1`,
      [inbound.id, RECEIVED_DATE]
    );
    const head = (await db.query(
      `select inbound_code, account_name, status, reference_number,
              expected_date::text, received_at, fulfillment_location_id, notes
         from portal_inbounds where id = $1`,
      [inbound.id]
    )).rows[0];
    const finalLines = (await db.query(
      `select sku, expected_quantity, received_quantity, received_location
         from portal_inbound_lines where inbound_id = $1 order by line_number`,
      [inbound.id]
    )).rows;
    const ledger = (await db.query(
      `select sku, sum(quantity_delta)::integer quantity
         from inventory_transactions
        where source_type = 'PORTAL_INBOUND' and source_id = $1::text
        group by sku order by sku`,
      [String(inbound.id)]
    )).rows;
    const results = [];
    for (const line of LINES) {
      const saved = finalLines.find((row) => row.sku === line.sku);
      const movement = ledger.find((row) => row.sku === line.sku);
      const stock = await db.query(
        `select coalesce(sum(quantity), 0)::integer quantity
           from inventory_lines where account_name = $1 and location = $2 and sku = $3`,
        [ACCOUNT, DESTINATION, line.sku]
      );
      const pickableTotal = Number(stock.rows[0].quantity);
      if (!saved || Number(saved.expected_quantity) !== line.quantity
        || Number(saved.received_quantity) !== line.quantity || saved.received_location !== DESTINATION
        || !movement || Number(movement.quantity) !== line.quantity
        || pickableTotal - before[line.sku] !== line.quantity) {
        throw new Error(`Post-receipt verification failed for ${line.sku}.`);
      }
      results.push({ sku: line.sku, receivedCases: line.quantity,
        unitsPerCase: line.unitsPerCase, pickableTotal });
    }
    if (head.account_name !== ACCOUNT || head.status !== "PUTAWAY_COMPLETE"
      || head.reference_number !== CONTAINER || head.expected_date !== EXPECTED_DATE
      || String(head.fulfillment_location_id) !== String(WAREHOUSE_ID)
      || new Date(head.received_at).toISOString().slice(0, 10) !== RECEIVED_DATE
      || !head.notes.includes("45 pallets total")) {
      throw new Error("Final inbound header verification failed.");
    }
    const output = {
      outcome: APPLY ? "created_received_and_available" : "dry_run_rolled_back",
      applied: APPLY,
      inbound: head.inbound_code,
      container: CONTAINER,
      account: ACCOUNT,
      warehouse: WAREHOUSE_CODE,
      status: head.status,
      expectedDate: EXPECTED_DATE,
      receivedDate: RECEIVED_DATE,
      palletCount: PALLET_COUNT,
      pickableLocation: DESTINATION,
      createdCatalogSku: !existing.has("WHOOPSIE-SMPL") ? "WHOOPSIE-SMPL" : "",
      lines: results,
      emailsSent: 0,
    };
    if (APPLY) {
      await db.query("commit");
      committed = true;
    } else {
      await db.query("rollback");
    }
    console.log(JSON.stringify(output));
  } catch (error) {
    if (!committed) await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
