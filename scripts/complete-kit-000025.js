"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "HEALTEA";
const CODE = "KIT-000025";
const SOURCE_SKU = "20628693486143";
const SOURCE_QTY = 20;
const TARGET_SKU = "628693486149";
const TARGET_QTY = 120;

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
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let committed = false;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`healtea-${CODE}`]);
    const requestResult = await db.query(
      `select * from portal_kitting_requests where request_code=$1 and account_name=$2 for update`,
      [CODE, ACCOUNT]
    );
    const request = requestResult.rows[0];
    if (requestResult.rowCount !== 1 || request.status !== "SUBMITTED"
      || Number(request.fulfillment_location_id) !== 1 || request.source_sku !== SOURCE_SKU
      || Number(request.source_quantity) !== SOURCE_QTY || request.target_sku !== TARGET_SKU
      || Number(request.target_quantity) !== TARGET_QTY) {
      throw new Error(`${CODE} identity, warehouse, definition, or status changed.`);
    }
    const allocations = (await db.query(
      `select a.*,i.quantity,b.account_name,b.fulfillment_location_id,b.location_type,b.is_pickable
         from portal_kitting_allocations a
         join inventory_lines i on i.id=a.inventory_line_id
         join bin_locations b on b.code=a.location
        where a.kitting_request_id=$1 order by a.id for update of i`,
      [request.id]
    )).rows;
    if (!allocations.length || allocations.reduce((sum, row) => sum + Number(row.allocated_quantity), 0) !== SOURCE_QTY
      || allocations.some((row) => row.sku !== SOURCE_SKU || Number(row.quantity) < Number(row.allocated_quantity)
        || row.account_name !== ACCOUNT || Number(row.fulfillment_location_id) !== 1
        || row.location_type !== "STORAGE" || row.is_pickable !== true)) {
      throw new Error(`${CODE} reserved inventory verification failed.`);
    }
    const before = Object.fromEntries((await db.query(
      `select sku,sum(quantity)::integer quantity from inventory_lines
        where account_name=$1 and sku=any($2::text[]) group by sku`,
      [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
    )).rows.map((row) => [row.sku, Number(row.quantity)]));

    const api = businessApi();
    const actor = { id: null, email: "operations@wms365.co", full_name: "Warehouse operations",
      role: api.codexAppUserRoles.SUPER_ADMIN };
    await api.codexUpdatePortalKittingRequestStatus(db, request.id, "COMPLETED", {
      warehouseNote: "Physical kitting confirmed complete by warehouse operations.",
    }, actor);

    const finalRequest = (await db.query(
      `select status,completed_at,completed_by,warehouse_note from portal_kitting_requests where id=$1`,
      [request.id]
    )).rows[0];
    const allocationCount = Number((await db.query(
      "select count(*)::integer count from portal_kitting_allocations where kitting_request_id=$1",
      [request.id]
    )).rows[0].count);
    const ledger = Object.fromEntries((await db.query(
      `select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions
        where source_type='PORTAL_KITTING_REQUEST' and source_id=$1 group by sku`,
      [CODE]
    )).rows.map((row) => [row.sku, Number(row.quantity_delta)]));
    const after = Object.fromEntries((await db.query(
      `select sku,sum(quantity)::integer quantity from inventory_lines
        where account_name=$1 and sku=any($2::text[]) group by sku`,
      [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
    )).rows.map((row) => [row.sku, Number(row.quantity)]));
    if (finalRequest.status !== "COMPLETED" || !finalRequest.completed_at
      || finalRequest.completed_by !== actor.full_name || allocationCount !== 0
      || ledger[SOURCE_SKU] !== -SOURCE_QTY || ledger[TARGET_SKU] !== TARGET_QTY
      || after[SOURCE_SKU] !== before[SOURCE_SKU] - SOURCE_QTY
      || after[TARGET_SKU] !== before[TARGET_SKU] + TARGET_QTY) {
      throw new Error(`${CODE} post-completion verification failed.`);
    }
    if (APPLY) { await db.query("commit"); committed = true; } else { await db.query("rollback"); }
    console.log(JSON.stringify({ applied: APPLY, outcome: APPLY ? "COMPLETED" : "DRY_RUN_ROLLED_BACK",
      request: CODE, sourceSku: SOURCE_SKU, consumed: SOURCE_QTY, targetSku: TARGET_SKU,
      produced: TARGET_QTY, targetOnHand: after[TARGET_SKU], emailsSent: 0 }));
  } catch (error) {
    if (!committed) await db.query("rollback").catch(() => {});
    throw error;
  } finally { await db.end(); }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
