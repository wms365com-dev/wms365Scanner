const { Client } = require('pg');
const {
  createReturnInboundFromShippedOrder,
  updateAdminPortalInboundStatus
} = require(process.env.WMS365_REMOTE_RUN ? './server' : '../server');

const ACCOUNT = 'ALCONA TRADING LTD';
const ORDER_CODE = 'ORD-000466';
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = 'WHS01';
const RECEIVING_LOCATION = 'WHS01-ALCONA-REC';
const RECEIVED_DATE = '2026-07-31';
const RECEIVED_AT = '2026-07-31 12:00:00-04';
const PALLET_REFERENCE = 'ORD-000466-RETURN-P1';

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.env.RAILWAY_PROJECT_ID !== '3f4e7e7e-7eda-4275-8dd0-2c1c3f869698'
    || process.env.RAILWAY_ENVIRONMENT_ID !== 'e1f5b77e-b935-4f41-9cc5-fccb28edbc57'
    || process.env.RAILWAY_SERVICE_ID !== '2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0') {
    throw new Error('Pinned WMS365 production service identity failed.');
  }
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [ORDER_CODE + ':return']);
    const warehouse = await db.query('select code,name,is_active from fulfillment_locations where id=$1', [WAREHOUSE_ID]);
    if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE
      || warehouse.rows[0].name !== 'Grey Wolf Edwards Warehouse' || !warehouse.rows[0].is_active) {
      throw new Error('Edwards warehouse identity failed.');
    }
    const assignment = await db.query(`select allow_returns,allow_inbound
      from company_fulfillment_locations where account_name=$1 and fulfillment_location_id=$2`, [ACCOUNT, WAREHOUSE_ID]);
    if (assignment.rowCount !== 1 || !assignment.rows[0].allow_returns || !assignment.rows[0].allow_inbound) {
      throw new Error('Alcona return/inbound warehouse assignment failed.');
    }
    const order = await db.query(`select id,status,confirmed_ship_date,fulfillment_location_id
      from portal_orders where order_code=$1 and account_name=$2 for update`, [ORDER_CODE, ACCOUNT]);
    if (order.rowCount !== 1 || order.rows[0].status !== 'SHIPPED'
      || Number(order.rows[0].fulfillment_location_id) !== WAREHOUSE_ID) {
      throw new Error('Exact shipped Alcona order and warehouse identity failed.');
    }
    const orderId = order.rows[0].id;
    const prior = await db.query(`select id,status from portal_inbounds
      where return_from_order_id=$1 or (account_name=$2 and reference_number=$3)`,
    [orderId, ACCOUNT, ORDER_CODE + '-RETURN']);
    if (prior.rowCount) {
      console.log(JSON.stringify({ outcome: 'existing_return_requires_review', existingCount: prior.rowCount, applied: false }));
      await db.query('ROLLBACK');
      return;
    }
    const lines = await db.query(`select l.id,l.sku,c.tracking_level,c.expiration_tracked,c.lot_tracked,
      coalesce(sum(sl.shipped_quantity),0)::integer shipped_quantity
      from portal_order_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
      left join warehouse_shipment_lines sl on sl.order_line_id=l.id
      where l.order_id=$1 group by l.id,l.sku,c.tracking_level,c.expiration_tracked,c.lot_tracked`, [orderId, ACCOUNT]);
    if (lines.rowCount !== 1 || lines.rows[0].tracking_level !== 'PALLET'
      || Number(lines.rows[0].shipped_quantity) !== 4) {
      throw new Error('Source order is not the expected four-pallet single-SKU shipment.');
    }
    const source = await db.query(`select count(*)::integer allocations,
      count(distinct expiration_date)::integer expiry_count,
      min(expiration_date)::text expiry_date,
      count(distinct nullif(lot_number,''))::integer lot_count,
      min(nullif(lot_number,'')) lot_number
      from portal_order_allocations where order_id=$1`, [orderId]);
    const facts = source.rows[0];
    if (facts.allocations !== 4 || facts.expiry_count !== 1 || !facts.expiry_date
      || (lines.rows[0].lot_tracked && facts.lot_count !== 1)) {
      throw new Error('Cannot identify one common shipped pallet expiry/lot without guessing.');
    }
    const before = await db.query(`select coalesce(sum(greatest(quantity,0)),0)::integer pallets
      from inventory_lines where account_name=$1 and tracking_level='PALLET'`, [ACCOUNT]);
    const result = await createReturnInboundFromShippedOrder(db, orderId, {
      expectedDate: RECEIVED_DATE,
      fulfillmentLocationId: WAREHOUSE_ID,
      carrierName: 'CUSTOMER RETURN'
    });
    if (result.alreadyExists || result.inbound.lines.length !== 1) throw new Error('Return inbound was not newly created with one line.');
    const inbound = result.inbound;
    const location = RECEIVING_LOCATION;
    await db.query('update portal_inbound_lines set expected_quantity=1,pallet_count=1,updated_at=now() where id=$1',
      [inbound.lines[0].id]);
    await db.query(`update portal_inbounds set arrived_at=$2::timestamptz,received_at=$2::timestamptz,
      notes=coalesce(notes,'') || $3,updated_at=now() where id=$1`, [inbound.id, RECEIVED_AT,
      ' Owner-attested physical return date: 2026-07-31. WMS source order ship date is 2026-08-24; chronology discrepancy retained for review. WMS return posting occurred later. No customer emails authorized.']);
    const received = await updateAdminPortalInboundStatus(db, inbound.id, 'RECEIVED', null, {
      receivingLocation: location,
      receivingLines: [{
        id: inbound.lines[0].id,
        sku: lines.rows[0].sku,
        receivedQuantity: 1,
        receivedLocation: location,
        expirationDate: facts.expiry_date,
        lotNumber: facts.lot_number || '',
        palletReference: PALLET_REFERENCE
      }],
      note: 'One owner-attested pallet returned 2026-07-31; WMS shipment recorded 2026-08-24. Hold in non-pickable receiving stage.'
    });
    const allocation = await db.query(`select count(*)::integer allocations,coalesce(sum(quantity),0)::integer pallets
      from portal_inbound_receipt_allocations where inbound_id=$1`, [inbound.id]);
    const movement = await db.query(`select count(*)::integer entries,coalesce(sum(quantity_delta),0)::integer pallets
      from inventory_transactions where account_name=$1 and transaction_type='RECEIVING'
        and source_type='PORTAL_INBOUND' and source_id=$2`, [ACCOUNT, String(inbound.id)]);
    const after = await db.query(`select coalesce(sum(greatest(quantity,0)),0)::integer pallets
      from inventory_lines where account_name=$1 and tracking_level='PALLET'`, [ACCOUNT]);
    const stage = await db.query('select location_type,is_pickable from bin_locations where code=$1', [location]);
    const saved = await db.query(`select status,received_at::date::text receipt_date,return_from_order_id
      from portal_inbounds where id=$1`, [inbound.id]);
    if (received.status !== 'RECEIVED_PENDING_PUTAWAY'
      || allocation.rows[0].allocations !== 1 || allocation.rows[0].pallets !== 1
      || movement.rows[0].pallets !== 1 || after.rows[0].pallets !== before.rows[0].pallets + 1
      || stage.rowCount !== 1 || stage.rows[0].is_pickable
      || saved.rows[0].receipt_date !== RECEIVED_DATE
      || String(saved.rows[0].return_from_order_id) !== String(orderId)) {
      throw new Error('Return receipt did not pass inventory, date, linkage, or staging verification.');
    }
    if (apply) await db.query('COMMIT'); else await db.query('ROLLBACK');
    console.log(JSON.stringify({ outcome: apply ? 'received' : 'dry_run_rolled_back',
      inboundCode: inbound.inboundCode, status: received.status,
      physicalReceiptDate: RECEIVED_DATE, before: before.rows[0].pallets,
      after: after.rows[0].pallets, returnedPallets: 1, emailsSent: 0 }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await db.end(); }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
