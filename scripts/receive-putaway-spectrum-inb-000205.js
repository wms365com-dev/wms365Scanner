const { Client } = require('pg');
const { APP_USER_ROLES, updateAdminPortalInboundStatus } = require('../server');

const APPLY = process.argv.includes('--apply');
const CODE = 'INB-000205';
const ACCOUNT = 'SPECTRUM DYES & PIGMENTS INC.';
const ACCOUNT_ID = '3918';
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = 'GW3PL-MISS';
const RECEIPT_DATE = '2026-10-06';
const DESTINATION = 'GW3PL-MISS-SPECTRUM-BULK';
const EXPECTED_REFERENCE = 'GW/1310/26';
const EXPECTED_LINES = new Map([
  ['SPECTRUM RED 185 SDB', 10],
  ['SPECTRUM YELLOW 83', 8],
]);
const EXPECTED_LOTS = new Map([
  ['SPECTRUM RED 185 SDB', '260612'],
  ['SPECTRUM YELLOW 83', '26330004'],
]);
const ACTOR = { id: null, email: 'operations@wms365.co', full_name: 'WMS365 Owner-Approved Inbound', role: APP_USER_ROLES.SUPER_ADMIN };

async function quantityBySku(db) {
  const result = await db.query(`select sku,coalesce(sum(quantity),0)::integer quantity from inventory_lines
    where account_name=$1 and location=$2 and sku=any($3::text[])
    group by sku`, [ACCOUNT, DESTINATION, [...EXPECTED_LINES.keys()]]);
  return new Map(result.rows.map((row) => [row.sku, Number(row.quantity)]));
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl: { rejectUnauthorized: false } });
  await db.connect();
  let committed = false;
  try {
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`${CODE}-RECEIVE-PUTAWAY`]);
    const account = await db.query('select id,name,is_active from owner_accounts where name=$1', [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error('Spectrum account identity mismatch.');
    }
    const inboundResult = await db.query(`select i.id,i.inbound_code,i.account_name,i.status,i.reference_number,
      i.fulfillment_location_id,i.received_at from portal_inbounds i where i.inbound_code=$1 for update`, [CODE]);
    if (inboundResult.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
    const row = inboundResult.rows[0];
    if (row.account_name !== ACCOUNT || row.reference_number !== EXPECTED_REFERENCE
        || Number(row.fulfillment_location_id) !== WAREHOUSE_ID) throw new Error('Inbound scope changed.');
    const warehouse = await db.query(`select fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
      from fulfillment_locations fl join company_fulfillment_locations cfl
      on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=$2`, [ACCOUNT, WAREHOUSE_ID]);
    if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE || !warehouse.rows[0].is_active
        || !warehouse.rows[0].allow_inbound || !warehouse.rows[0].allow_outbound || !warehouse.rows[0].allow_storage) {
      throw new Error('Spectrum warehouse assignment is not valid.');
    }
    const linesResult = await db.query(`select l.id,l.sku,l.expected_quantity,l.received_quantity,
      c.description,c.upc,c.tracking_level,c.blocked,c.item_type
      from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
      where l.inbound_id=$1 order by l.line_number for update of l`, [row.id, ACCOUNT]);
    if (linesResult.rowCount !== EXPECTED_LINES.size || linesResult.rows.some((line) =>
      EXPECTED_LINES.get(line.sku) !== Number(line.expected_quantity) || line.received_quantity != null
      || line.blocked || line.item_type !== 'INVENTORY')) throw new Error('Inbound line identity, quantity, or item eligibility changed.');
    const docs = await db.query(`select count(*)::integer count from portal_inbound_documents
      where inbound_id=$1 and document_category='SHIPMENT_PACKING_SLIP'`, [row.id]);
    if (Number(docs.rows[0].count) < 1) throw new Error('Shipment packing slip is missing.');
    const priorLedger = await db.query(`select count(*)::integer count from inventory_transactions
      where source_type='PORTAL_INBOUND' and source_id=$1::text`, [String(row.id)]);
    if (row.status === 'PUTAWAY_COMPLETE' && row.received_at) {
      const savedDate = await db.query(`select to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date
        from portal_inbounds where id=$1`, [row.id]);
      await db.query('rollback');
      return console.log(JSON.stringify({ outcome: 'already_received', applied: false, inbound: CODE,
        status: row.status, receiptDate: savedDate.rows[0].receipt_date }));
    }
    if (row.status !== 'SUBMITTED' || row.received_at || Number(priorLedger.rows[0].count) !== 0) {
      throw new Error('Inbound has already advanced or has prior receipt activity.');
    }
    const bin = await db.query(`select code,account_name,fulfillment_location_id,location_type,is_pickable
      from bin_locations where code=$1 for update`, [DESTINATION]);
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT
        || Number(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID
        || bin.rows[0].location_type !== 'STORAGE' || !bin.rows[0].is_pickable) {
      throw new Error('Spectrum pickable destination is not valid.');
    }
    const before = await quantityBySku(db);
    let inbound = await updateAdminPortalInboundStatus(db, row.id, 'ARRIVED', ACTOR,
      { note: `Received ${RECEIPT_DATE} from packing slip ${EXPECTED_REFERENCE}.` });
    inbound = await updateAdminPortalInboundStatus(db, row.id, 'RECEIVED', ACTOR, {
      receivingLocation: DESTINATION,
      receivingLines: inbound.lines.map((line) => ({ id: line.id, sku: line.sku,
        receivedQuantity: EXPECTED_LINES.get(line.sku), receivedLocation: DESTINATION,
        lotNumber: EXPECTED_LOTS.get(line.sku) })),
      note: 'Received in full per owner instruction.',
    });
    await db.query(`update bin_locations set location_type='STORAGE',is_pickable=true,account_name=$2,
      fulfillment_location_id=$3,updated_at=now() where code=$1`, [DESTINATION, ACCOUNT, WAREHOUSE_ID]);
    inbound = await updateAdminPortalInboundStatus(db, row.id, 'PUTAWAY_COMPLETE', ACTOR,
      { note: `All quantities put away to ${DESTINATION}; inventory is pickable.` });
    await db.query(`update portal_inbounds set
      arrived_at=($2::date + time '12:00') at time zone 'America/Toronto',
      received_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now() where id=$1`,
      [row.id, RECEIPT_DATE]);
    const [finalInbound, finalLines, ledger] = await Promise.all([
      db.query(`select status,to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date
        from portal_inbounds where id=$1`, [row.id]),
      db.query(`select sku,expected_quantity,received_quantity,received_location,lot_number from portal_inbound_lines
        where inbound_id=$1 order by line_number`, [row.id]),
      db.query(`select sku,sum(quantity_delta)::integer quantity from inventory_transactions
        where source_type='PORTAL_INBOUND' and source_id=$1::text and transaction_type='RECEIVING'
        group by sku`, [String(row.id)]),
    ]);
    const after = await quantityBySku(db);
    const ledgerMap = new Map(ledger.rows.map((entry) => [entry.sku, Number(entry.quantity)]));
    if (finalInbound.rows[0].status !== 'PUTAWAY_COMPLETE' || finalInbound.rows[0].receipt_date !== RECEIPT_DATE
        || finalLines.rows.some((line) => Number(line.received_quantity) !== EXPECTED_LINES.get(line.sku)
          || line.received_location !== DESTINATION || line.lot_number !== EXPECTED_LOTS.get(line.sku))
        || [...EXPECTED_LINES].some(([sku, quantity]) => ledgerMap.get(sku) !== quantity
          || (after.get(sku) || 0) - (before.get(sku) || 0) !== quantity)) {
      throw new Error('Post-receipt verification failed.');
    }
    const result = { outcome: APPLY ? 'received_and_available' : 'dry_run_rolled_back', applied: APPLY,
      inbound: CODE, account: ACCOUNT, warehouse: WAREHOUSE_CODE, status: finalInbound.rows[0].status,
      receiptDate: finalInbound.rows[0].receipt_date, pickableLocation: DESTINATION,
      received: [...EXPECTED_LINES].map(([sku, quantity]) => ({ sku, quantity, lot: EXPECTED_LOTS.get(sku) })), totalReceived: 18 };
    if (APPLY) { await db.query('commit'); committed = true; } else await db.query('rollback');
    console.log(JSON.stringify(result));
  } catch (error) { if (!committed) await db.query('rollback').catch(() => {}); throw error; }
  finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
