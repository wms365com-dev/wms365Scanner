const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const SKU = "S164";
const LOCATION = "GW3PL-MISS-ZETA-BULK";
const EXPECTED_BEFORE = 23;
const TARGET = 31;
const DELTA = TARGET - EXPECTED_BEFORE;
const CONFIRMATION = "APPROVED_ZETA_S164_TO_31_20261020";
const IDEMPOTENCY_KEY = "MANUAL-ADJUST-ZETA-S164-31-20261020";

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin");
    const company = await db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
    if (company.rowCount !== 1 || company.rows[0].is_active !== true) throw new Error("Exact active Zeta tenant verification failed.");
    const item = await db.query("select sku,description,upc,blocked from item_catalog where account_name=$1 and sku=$2", [ACCOUNT, SKU]);
    if (item.rowCount !== 1 || item.rows[0].blocked === true) throw new Error("Exact active S164 item verification failed.");
    const bin = await db.query(`
      select b.code,b.fulfillment_location_id,f.code warehouse_code,f.name warehouse_name,f.is_active
      from bin_locations b join fulfillment_locations f on f.id=b.fulfillment_location_id
      where b.account_name=$1 and b.code=$2`, [ACCOUNT, LOCATION]);
    if (bin.rowCount !== 1 || Number(bin.rows[0].fulfillment_location_id) !== 1 || bin.rows[0].is_active !== true) {
      throw new Error("Pinned Mississauga inventory location verification failed.");
    }
    const lines = await db.query(`select * from inventory_lines
      where account_name=$1 and sku=$2 and location=$3 order by id for update`, [ACCOUNT, SKU, LOCATION]);
    if (lines.rowCount !== 1) throw new Error(`Expected exactly one S164 inventory line at ${LOCATION}; found ${lines.rowCount}.`);
    const line = lines.rows[0];
    const priorTx = await db.query("select * from inventory_transactions where idempotency_key=$1", [IDEMPOTENCY_KEY]);
    const current = Number(line.quantity);
    if (priorTx.rowCount) {
      if (current !== TARGET || priorTx.rowCount !== 1 || Number(priorTx.rows[0].quantity_after) !== TARGET) {
        throw new Error("Existing idempotent adjustment does not match the current target state.");
      }
      await db.query("rollback");
      console.log(JSON.stringify({ mode: APPLY ? "apply" : "preflight", alreadyApplied: true, account: ACCOUNT, sku: SKU, description: item.rows[0].description, location: LOCATION, onHand: current }));
      return;
    }
    if (current !== EXPECTED_BEFORE) throw new Error(`S164 balance changed: expected ${EXPECTED_BEFORE}, found ${current}. No adjustment applied.`);
    const allocations = await db.query(`select coalesce(sum(a.allocated_quantity),0)::integer allocated
      from portal_order_allocations a join portal_orders o on o.id=a.order_id
      where a.inventory_line_id=$1 and o.status not in ('SHIPPED','CANCELLED')`, [line.id]);
    if (APPLY && process.env.CONFIRM_ZETA_S164_ADJUSTMENT !== CONFIRMATION) throw new Error(`Set CONFIRM_ZETA_S164_ADJUSTMENT=${CONFIRMATION}.`);
    if (APPLY) {
      const updated = await db.query("update inventory_lines set quantity=$1,updated_at=now() where id=$2 and quantity=$3 returning *", [TARGET, line.id, EXPECTED_BEFORE]);
      if (updated.rowCount !== 1) throw new Error("Concurrent inventory change detected; adjustment stopped.");
      const tx = await db.query(`insert into inventory_transactions (
        account_name,warehouse_id,fulfillment_location_id,location,sku,upc,lot_number,expiration_date,
        transaction_type,quantity_delta,quantity_before,quantity_after,source_type,source_id,
        idempotency_key,source,server_timestamp)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'ADJUSTMENT',$9,$10,$11,'OWNER_APPROVED_CYCLE_COUNT',$12,$13,'system',now())
        returning id,quantity_delta,quantity_before,quantity_after,idempotency_key,server_timestamp`,
      [ACCOUNT,bin.rows[0].warehouse_code,bin.rows[0].fulfillment_location_id,LOCATION,SKU,line.upc || item.rows[0].upc || "",
       line.lot_number || "",line.expiration_date || "",DELTA,EXPECTED_BEFORE,TARGET,"S164-COUNT-31-20261020",IDEMPOTENCY_KEY]);
      await db.query("commit");
      console.log(JSON.stringify({ mode: "apply", account: ACCOUNT, sku: SKU, description: item.rows[0].description,
        warehouse: bin.rows[0].warehouse_name, location: LOCATION, before: EXPECTED_BEFORE, adjustment: DELTA,
        after: TARGET, allocated: allocations.rows[0].allocated, available: TARGET - Number(allocations.rows[0].allocated), ledger: tx.rows[0] }));
    } else {
      await db.query("rollback");
      console.log(JSON.stringify({ mode: "preflight", account: ACCOUNT, sku: SKU, description: item.rows[0].description,
        warehouse: bin.rows[0].warehouse_name, location: LOCATION, before: current, adjustment: DELTA,
        after: TARGET, allocated: allocations.rows[0].allocated, availableAfter: TARGET - Number(allocations.rows[0].allocated) }));
    }
  } catch (error) {
    try { await db.query("rollback"); } catch {}
    throw error;
  } finally { await db.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
module.exports = { main };
