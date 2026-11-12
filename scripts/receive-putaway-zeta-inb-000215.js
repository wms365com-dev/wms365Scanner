const { Client } = require('pg');
const { APP_USER_ROLES, createInventoryMovementRecord, safeTransferInventoryQuantity,
  updateAdminPortalInboundStatus } = require('/app/server.js');

const APPLY = process.argv.includes('--apply');
const ACCOUNT = 'ZETA GROUP (CANADA) LTD.';
const ACCOUNT_ID = '1566';
const INBOUND = 'INB-000215';
const SKU = 'S001W';
const QUANTITY = 300;
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = 'GW3PL-MISS';
const RECEIVING = 'GW3PL-MISS-ZETA-REC';
const DESTINATION = 'GW3PL-MISS-ZETA-BULK';
const PALLET_REFERENCE = 'LAX00766660-P01';
const MOVEMENT_KEY = 'INB-000215-PUTAWAY-S001W';
const ACTOR = { id: null, email: 'operations@wms365.co', full_name: 'WMS365 Owner-Approved Inbound', role: APP_USER_ROLES.SUPER_ADMIN };

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let committed = false;
  try {
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`${INBOUND}-RECEIVE-PUTAWAY`]);
    const account = await db.query('select id,name,is_active from owner_accounts where name=$1', [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) throw new Error('Zeta account identity mismatch.');
    const warehouse = await db.query(`select fl.id,fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
      from fulfillment_locations fl join company_fulfillment_locations cfl on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
      where fl.id=$2`, [ACCOUNT, WAREHOUSE_ID]);
    if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE || !warehouse.rows[0].is_active
        || !warehouse.rows[0].allow_inbound || !warehouse.rows[0].allow_outbound || !warehouse.rows[0].allow_storage) throw new Error('Zeta warehouse assignment mismatch.');
    const item = await db.query(`select description,upc,tracking_level,units_per_case,blocked,item_type
      from item_catalog where account_name=$1 and sku=$2`, [ACCOUNT, SKU]);
    if (item.rowCount !== 1 || item.rows[0].tracking_level !== 'CASE' || Number(item.rows[0].units_per_case) !== 10
        || item.rows[0].blocked || item.rows[0].item_type !== 'INVENTORY') throw new Error('S001W is not configured for releasable case inventory.');
    const inbound = await db.query(`select i.id,i.status,i.account_name,i.fulfillment_location_id,i.reference_number,i.carrier_name,
      i.received_at,l.id line_id,l.sku,l.expected_quantity,l.received_quantity
      from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id where i.inbound_code=$1
      for update of i,l`, [INBOUND]);
    if (inbound.rowCount !== 1 || inbound.rows[0].account_name !== ACCOUNT || Number(inbound.rows[0].fulfillment_location_id) !== WAREHOUSE_ID
        || inbound.rows[0].reference_number !== 'LAX00766660' || inbound.rows[0].carrier_name !== 'Mainfreight'
        || inbound.rows[0].sku !== SKU || Number(inbound.rows[0].expected_quantity) !== QUANTITY) throw new Error('Inbound identity or quantity changed.');
    const row = inbound.rows[0];
    const docs = await db.query('select count(*)::integer count from portal_inbound_documents where inbound_id=$1', [row.id]);
    if (Number(docs.rows[0].count) < 1) throw new Error('Inbound POD is missing.');
    const bins = await db.query(`select code,account_name,fulfillment_location_id,location_type,is_pickable
      from bin_locations where code=any($1::text[]) order by code`, [[RECEIVING, DESTINATION]]);
    const rec = bins.rows.find(b => b.code === RECEIVING); const bulk = bins.rows.find(b => b.code === DESTINATION);
    if (!rec || rec.account_name !== ACCOUNT || Number(rec.fulfillment_location_id) !== WAREHOUSE_ID
        || rec.location_type !== 'RECEIVING_STAGE' || rec.is_pickable) throw new Error('Zeta receiving stage mismatch.');
    if (!bulk || bulk.account_name !== ACCOUNT || Number(bulk.fulfillment_location_id) !== WAREHOUSE_ID
        || bulk.location_type !== 'STORAGE' || !bulk.is_pickable) throw new Error('Zeta bulk location is not pickable storage.');
    const movement = await db.query('select id from inventory_movements where movement_key=$1', [MOVEMENT_KEY]);
    if (row.status === 'PUTAWAY_COMPLETE') {
      if (movement.rowCount !== 1) throw new Error('Completed inbound lacks putaway movement history.');
      const pallet = await db.query('select id,pallet_status,actual_quantity from portal_inbound_pallet_labels where inbound_id=$1', [row.id]);
      if (pallet.rowCount > 1) throw new Error('Completed inbound has conflicting pallet labels.');
      if (APPLY && pallet.rowCount === 0) {
        await db.query(`insert into portal_inbound_pallet_labels
          (inbound_id,line_id,pallet_code,account_name,sku,upc,description,cases_on_pallet,expected_quantity,
           pallet_type,pallet_status,is_mixed,billable,pallet_size_type,actual_quantity,confirmed_by,confirmed_at,notes,label_date,created_by)
          values($1,$2,$3,$4,$5,$6,$7,$8,$8,'SINGLE_SKU','RECEIVED',false,true,'STANDARD_40_48_55',$8,$9,now(),$10,current_date,$9)`,
        [row.id,row.line_id,PALLET_REFERENCE,ACCOUNT,SKU,item.rows[0].upc,item.rows[0].description,QUANTITY,ACTOR.full_name,`${INBOUND} one-pallet receipt.`]);
        await db.query(`update portal_inbound_lines set pallet_count=1,pallet_codes=$2,updated_at=now() where id=$1`, [row.line_id,PALLET_REFERENCE]);
      }
      if (APPLY) { await db.query('commit'); committed = true; } else await db.query('rollback');
      return console.log(JSON.stringify({ outcome: pallet.rowCount ? 'already_received' : (APPLY ? 'pallet_metadata_completed' : 'would_complete_pallet_metadata'),
        applied: APPLY, inbound: INBOUND, status: row.status, palletCount: 1 }));
    }
    if (row.status !== 'SUBMITTED' || row.received_at || row.received_quantity != null || movement.rowCount) throw new Error('Inbound state requires review before receipt.');
    const before = await db.query(`select coalesce(sum(quantity),0)::integer quantity from inventory_lines
      where account_name=$1 and sku=$2 and location=$3`, [ACCOUNT, SKU, DESTINATION]);
    let state = await updateAdminPortalInboundStatus(db, row.id, 'ARRIVED', ACTOR, { note: 'Mainfreight pallet physically received.' });
    state = await updateAdminPortalInboundStatus(db, row.id, 'RECEIVED', ACTOR, {
      receivingLocation: RECEIVING,
      receivingLines: [{ id: row.line_id, sku: SKU, receivedQuantity: QUANTITY, receivedLocation: RECEIVING,
        palletReference: PALLET_REFERENCE, palletSizeType: 'STANDARD_40_48_55' }],
      note: `One pallet received: ${QUANTITY} cases of ${SKU}.`,
    });
    if (state.status !== 'RECEIVED_PENDING_PUTAWAY') throw new Error(`Receipt reached ${state.status}, not pending putaway.`);
    const source = await db.query(`select * from inventory_lines where account_name=$1 and sku=$2 and location=$3 and quantity>0 order by id for update`,
    [ACCOUNT, SKU, RECEIVING]);
    if (source.rows.reduce((sum, line) => sum + Number(line.quantity), 0) !== QUANTITY) throw new Error('Receiving-stage quantity mismatch.');
    let remaining = QUANTITY;
    for (const line of source.rows) {
      const move = Math.min(Number(line.quantity), remaining);
      await safeTransferInventoryQuantity(db, line, { accountName: ACCOUNT, location: DESTINATION, sku: SKU,
        upc: line.upc || '', lotNumber: line.lot_number || '', expirationDate: line.expiration_date || '', trackingLevel: 'CASE' }, move, {
        actionLabel: 'put away Zeta S001W receipt', transactionType: 'PUT_AWAY', sourceType: 'PORTAL_INBOUND_PUTAWAY',
        sourceId: row.id, fulfillmentLocationId: WAREHOUSE_ID, appUser: ACTOR, source: 'web_admin',
      });
      remaining -= move;
    }
    if (remaining !== 0) throw new Error('Not all received cases were put away.');
    await createInventoryMovementRecord(db, { movementKey: MOVEMENT_KEY, accountName: ACCOUNT,
      fulfillmentLocationId: WAREHOUSE_ID, movementType: 'TRANSFER', fromLocation: RECEIVING,
      toLocation: DESTINATION, line: source.rows[0], quantity: QUANTITY, reason: `${INBOUND} putaway: ${QUANTITY} cases of ${SKU}` });
    state = await updateAdminPortalInboundStatus(db, row.id, 'PUTAWAY_COMPLETE', ACTOR, { note: `One pallet / ${QUANTITY} cases put away to ${DESTINATION}; inventory is pickable.` });
    const [lineCheck,stageCheck,bulkCheck,activeAllocations] = await Promise.all([
      db.query(`select received_quantity,received_location,pallet_count,pallet_codes from portal_inbound_lines where inbound_id=$1`, [row.id]),
      db.query(`select coalesce(sum(quantity),0)::integer quantity from inventory_lines where account_name=$1 and sku=$2 and location=$3`, [ACCOUNT, SKU, RECEIVING]),
      db.query(`select coalesce(sum(quantity),0)::integer quantity from inventory_lines where account_name=$1 and sku=$2 and location=$3`, [ACCOUNT, SKU, DESTINATION]),
      db.query(`select coalesce(sum(a.allocated_quantity),0)::integer quantity from portal_order_allocations a join portal_orders o on o.id=a.order_id
        where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED') and a.sku=$2`, [ACCOUNT, SKU]),
    ]);
    const bulkAfter = Number(bulkCheck.rows[0].quantity); const allocated = Number(activeAllocations.rows[0].quantity);
    const available = bulkAfter - allocated;
    if (state.status !== 'PUTAWAY_COMPLETE' || Number(lineCheck.rows[0].received_quantity) !== QUANTITY
        || lineCheck.rows[0].received_location !== RECEIVING || Number(stageCheck.rows[0].quantity) !== 0
        || bulkAfter - Number(before.rows[0].quantity) !== QUANTITY || available < QUANTITY) throw new Error('Post-receipt release availability verification failed.');
    const result = { outcome: APPLY ? 'received_and_put_away' : 'dry_run_rolled_back', applied: APPLY,
      inbound: INBOUND, account: ACCOUNT, warehouse: WAREHOUSE_CODE, status: state.status, sku: SKU,
      receivedCases: QUANTITY, palletCount: 1, pickableLocation: DESTINATION, inventoryAdded: QUANTITY,
      totalPickableInventory: bulkAfter, allocatedToOpenOrders: allocated, availableForRelease: available };
    if (APPLY) { await db.query('commit'); committed = true; } else await db.query('rollback');
    console.log(JSON.stringify(result));
  } catch (error) { if (!committed) await db.query('rollback').catch(() => {}); throw error; }
  finally { await db.end(); }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
