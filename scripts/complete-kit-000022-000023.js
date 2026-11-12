"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "HEALTEA";
const WAREHOUSE_ID = 1;
const REQUESTS = [
  { code: "KIT-000022", sourceSku: "20628693486136", sourceQuantity: 10, targetSku: "628693486132", targetQuantity: 60 },
  { code: "KIT-000023", sourceSku: "20628693486150", sourceQuantity: 12, targetSku: "628693486156", targetQuantity: 72 },
];

function businessApi() {
  const filename = require.resolve("../server");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, "utf8")
    + "\nmodule.exports.codexUpdatePortalKittingRequestStatus=updatePortalKittingRequestStatus;"
    + "\nmodule.exports.codexAppUserRoles=APP_USER_ROLES;", filename);
  return mod.exports;
}

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  let committed = false;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", ["healtea-kit-000022-000023"]);
    const account = await db.query("select id, is_active from owner_accounts where name=$1", [ACCOUNT]);
    if (account.rowCount !== 1 || account.rows[0].is_active !== true) {
      throw new Error("Exact active HEALTEA account verification failed.");
    }
    const warehouse = await db.query(
      `select fl.code, fl.is_active, cfl.allow_storage
         from fulfillment_locations fl
         join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
        where fl.id=$2`,
      [ACCOUNT, WAREHOUSE_ID]
    );
    if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== "GW3PL-MISS"
      || warehouse.rows[0].is_active !== true || warehouse.rows[0].allow_storage !== true) {
      throw new Error("HEALTEA Mississauga warehouse verification failed.");
    }

    const before = new Map();
    const requestRows = [];
    for (const expected of REQUESTS) {
      const requestResult = await db.query(
        `select * from portal_kitting_requests
          where request_code=$1 and account_name=$2 for update`,
        [expected.code, ACCOUNT]
      );
      if (requestResult.rowCount !== 1) throw new Error(`${expected.code} identity verification failed.`);
      const request = requestResult.rows[0];
      if (request.status !== "SUBMITTED" || Number(request.fulfillment_location_id) !== WAREHOUSE_ID
        || request.source_sku !== expected.sourceSku || Number(request.source_quantity) !== expected.sourceQuantity
        || request.target_sku !== expected.targetSku || Number(request.target_quantity) !== expected.targetQuantity) {
        throw new Error(`${expected.code} definition or status changed.`);
      }
      const allocations = (await db.query(
        `select a.inventory_line_id, a.sku, a.location, a.allocated_quantity, i.quantity,
                b.account_name, b.fulfillment_location_id, b.location_type, b.is_pickable
           from portal_kitting_allocations a
           join inventory_lines i on i.id=a.inventory_line_id
           join bin_locations b on b.code=a.location
          where a.kitting_request_id=$1 order by a.id for update of i`,
        [request.id]
      )).rows;
      const allocated = allocations.reduce((sum, row) => sum + Number(row.allocated_quantity), 0);
      if (!allocations.length || allocations.some((row) => row.sku !== expected.sourceSku
        || Number(row.quantity) < Number(row.allocated_quantity)
        || row.account_name !== ACCOUNT || Number(row.fulfillment_location_id) !== WAREHOUSE_ID
        || row.location_type !== "STORAGE" || row.is_pickable !== true)
        || allocated !== expected.sourceQuantity) {
        throw new Error(`${expected.code} reserved component verification failed.`);
      }
      const totals = await db.query(
        `select sku, coalesce(sum(quantity),0)::integer quantity
           from inventory_lines where account_name=$1 and sku=any($2::text[])
          group by sku`,
        [ACCOUNT, [expected.sourceSku, expected.targetSku]]
      );
      before.set(expected.code, Object.fromEntries(totals.rows.map((row) => [row.sku, Number(row.quantity)])));
      requestRows.push({ expected, request });
    }

    const api = businessApi();
    const actor = {
      id: null,
      email: "operations@wms365.co",
      full_name: "Warehouse operations",
      role: api.codexAppUserRoles.SUPER_ADMIN,
    };
    for (const { expected, request } of requestRows) {
      await api.codexUpdatePortalKittingRequestStatus(db, request.id, "COMPLETED", {
        warehouseNote: "Physical kitting confirmed complete by warehouse operations.",
      }, actor);
    }

    const results = [];
    for (const { expected, request } of requestRows) {
      const finalRequest = (await db.query(
        `select request_code,status,completed_at,completed_by,warehouse_note
           from portal_kitting_requests where id=$1`,
        [request.id]
      )).rows[0];
      const allocationCount = Number((await db.query(
        "select count(*)::integer count from portal_kitting_allocations where kitting_request_id=$1",
        [request.id]
      )).rows[0].count);
      const ledger = (await db.query(
        `select sku, sum(quantity_delta)::integer quantity_delta
           from inventory_transactions
          where source_type='PORTAL_KITTING_REQUEST' and source_id=$1
          group by sku order by sku`,
        [expected.code]
      )).rows;
      const totals = (await db.query(
        `select sku, coalesce(sum(quantity),0)::integer quantity
           from inventory_lines where account_name=$1 and sku=any($2::text[])
          group by sku`,
        [ACCOUNT, [expected.sourceSku, expected.targetSku]]
      )).rows;
      const after = Object.fromEntries(totals.map((row) => [row.sku, Number(row.quantity)]));
      const initial = before.get(expected.code);
      const sourceLedger = ledger.find((row) => row.sku === expected.sourceSku);
      const targetLedger = ledger.find((row) => row.sku === expected.targetSku);
      if (finalRequest.status !== "COMPLETED" || !finalRequest.completed_at
        || finalRequest.completed_by !== actor.full_name || allocationCount !== 0
        || !sourceLedger || Number(sourceLedger.quantity_delta) !== -expected.sourceQuantity
        || !targetLedger || Number(targetLedger.quantity_delta) !== expected.targetQuantity
        || after[expected.sourceSku] !== initial[expected.sourceSku] - expected.sourceQuantity
        || after[expected.targetSku] !== initial[expected.targetSku] + expected.targetQuantity) {
        throw new Error(`${expected.code} post-completion verification failed.`);
      }
      results.push({ request: expected.code, status: finalRequest.status,
        sourceSku: expected.sourceSku, consumed: expected.sourceQuantity,
        targetSku: expected.targetSku, produced: expected.targetQuantity,
        targetOnHand: after[expected.targetSku] });
    }

    if (APPLY) {
      await db.query("commit");
      committed = true;
    } else {
      await db.query("rollback");
    }
    console.log(JSON.stringify({ applied: APPLY, outcome: APPLY ? "COMPLETED" : "DRY_RUN_ROLLED_BACK",
      account: ACCOUNT, warehouse: "GW3PL-MISS", results, emailsSent: 0 }));
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
