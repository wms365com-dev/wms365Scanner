const { Pool } = require('pg');
const {
  APP_USER_ROLES,
  getPortalOrderById,
  reallocatePortalOrderToActualPalletLocations,
  safeDeductInventoryLineQuantity,
  updateWarehouseShipmentDetail,
  upsertInventoryLine,
} = require('/app/server.js');

const APPLY = process.argv.includes('--apply');
const CODE = 'ORD-001396';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const WAREHOUSE_CODE = 'WHS01';
const SKU = 'MS26062403';
const LOT = 'MS26062403';
const PALLETS = [
  { palletNumber: 1, from: 'DI28AC', location: 'DI34AB', weight: 2313, weightUom: 'LB' },
  { palletNumber: 2, from: 'DI30AC', location: 'DI36AA', weight: 2300, weightUom: 'LB' },
  { palletNumber: 3, from: 'DI32AC', location: 'DI38AA', weight: 2310, weightUom: 'LB' },
  { palletNumber: 4, from: 'DI34AA', location: 'DI40AA', weight: 2313, weightUom: 'LB' },
];
const TOTAL_WEIGHT = PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0);
const NOTE = `Warehouse-confirmed physical pick bins and weights: ${PALLETS.map((p) => `${p.location} ${p.weight} lb`).join('; ')}. SKU and batch/lot ${LOT}.`;
const ACTOR = {
  id: null,
  email: 'prathab@greywolf3pl.com',
  full_name: 'Owner-confirmed pick location correction',
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!APPLY) await client.query('SET TRANSACTION READ ONLY');
    const found = await client.query(`
      select o.*, fl.code as warehouse_code
      from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1 ${APPLY ? 'for update of o' : ''}
    `, [CODE]);
    if (found.rowCount !== 1) throw new Error('Order identity is not unique.');
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID
        || row.warehouse_code !== WAREHOUSE_CODE || row.status !== 'STAGED' || row.shipped_at
        || Number(row.outbound_total_pallets) !== 4 || row.shipped_tracking_reference) {
      throw new Error('Order identity or shipping state changed.');
    }
    const order = await getPortalOrderById(client, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== SKU || Number(order.lines[0].quantity) !== 4
        || order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== 'STAGED') {
      throw new Error('Order lines or staged shipment changed.');
    }
    const allocations = await client.query(`
      select a.id,a.inventory_line_id,a.location,a.sku,a.lot_number,a.allocated_quantity,
             i.account_name,i.quantity,i.upc,i.expiration_date,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id ${APPLY ? 'for update of a, i' : ''}
    `, [row.id]);
    if (allocations.rowCount !== 4) throw new Error('Expected four pallet allocations.');
    const common = allocations.rows.every((a) => a.sku === SKU && a.lot_number === LOT
      && a.account_name === ACCOUNT && Number(a.allocated_quantity) === 1
      && Number(a.quantity) === 1 && a.tracking_level === 'PALLET');
    const sourceMode = common && allocations.rows.every((a, i) => a.location === PALLETS[i].from);
    const targetMode = common && allocations.rows.every((a, i) => a.location === PALLETS[i].location);
    if (!sourceMode && !targetMode) throw new Error('Allocation locations, lot, or quantities differ from review.');
    const expectedPicked = PALLETS.map((p) => sourceMode ? p.from : p.location);
    if (JSON.stringify((row.picked_pallet_details || []).map((p) => p.location)) !== JSON.stringify(expectedPicked)) {
      throw new Error('Picked pallet details conflict with active allocations.');
    }
    if (row.routing_total_weight != null && Number(row.routing_total_weight) !== TOTAL_WEIGHT) {
      throw new Error('Recorded total weight conflicts with the warehouse report.');
    }
    const bins = await client.query(`select code,is_pickable,fulfillment_location_id from bin_locations
      where upper(code)=any($1::text[])`, [PALLETS.map((p) => p.location)]);
    if (bins.rowCount !== 4 || bins.rows.some((b) => !b.is_pickable
        || (b.fulfillment_location_id != null && String(b.fulfillment_location_id) !== WAREHOUSE_ID))) {
      throw new Error('One or more target bins are missing, non-pickable, or assigned to another warehouse.');
    }
    const targets = await client.query(`select id,location,sku,lot_number,quantity,tracking_level
      from inventory_lines where account_name=$1 and sku=$2 and upper(location)=any($3::text[])
      order by location,id ${APPLY ? 'for update' : ''}`,
    [ACCOUNT, SKU, PALLETS.map((p) => p.location)]);
    const validTargets = targets.rows.length === 4 && targets.rows.every((line) =>
      line.lot_number === LOT && Number(line.quantity) >= 1 && line.tracking_level === 'PALLET');
    if (sourceMode && targets.rowCount && !validTargets) throw new Error('Target-bin inventory conflicts with the reported pallets.');
    if (APPLY && sourceMode) {
      for (let i = 0; i < PALLETS.length; i += 1) {
        const p = PALLETS[i]; const a = allocations.rows[i];
        await upsertInventoryLine(client, { accountName: ACCOUNT, location: p.location, sku: SKU,
          upc: a.upc || '', lotNumber: LOT, expirationDate: a.expiration_date || '',
          trackingLevel: 'PALLET', quantity: 1 }, {
          transactionType: 'MOVE_LOCATION', sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION',
          sourceId: row.id, fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR,
          source: 'web_admin', idempotencyKey: `${CODE}-${p.from}-to-${p.location}`,
        });
      }
      await reallocatePortalOrderToActualPalletLocations(client, order, PALLETS, ACTOR);
      for (let i = 0; i < PALLETS.length; i += 1) {
        const p = PALLETS[i];
        await safeDeductInventoryLineQuantity(client, allocations.rows[i].inventory_line_id, 1, {
          actionLabel: `record physical pallet move ${p.from} to ${p.location}`,
          transactionType: 'MOVE_LOCATION', sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION',
          sourceId: row.id, fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR,
          source: 'web_admin', idempotencyKey: `${CODE}-${p.from}-to-${p.location}`,
        });
      }
    }
    if (APPLY) {
      const notes = String(row.order_notes || '').includes(NOTE) ? row.order_notes : `${row.order_notes || ''}\n${NOTE}`.trim();
      await client.query(`update portal_orders set picked_pallet_details=$2::jsonb,
        routing_total_weight=$3,routing_weight_uom='LB',order_notes=$4,updated_at=now() where id=$1`,
      [row.id, JSON.stringify(PALLETS.map(({ palletNumber, location, weight, weightUom }) =>
        ({ palletNumber, location, weight, weightUom }))), TOTAL_WEIGHT, notes]);
      await updateWarehouseShipmentDetail(client, order.warehouseShipments[0].id, {
        status: 'STAGED', totalPallets: 4, totalWeight: TOTAL_WEIGHT, weightUom: 'LB',
      }, { accountName: ACCOUNT, actor: ACTOR.full_name });
    }
    const finalOrder = await getPortalOrderById(client, row.id, ACCOUNT);
    const finalAllocations = await client.query(`select a.location,a.sku,a.lot_number,a.allocated_quantity,
      i.quantity,i.account_name,i.tracking_level from portal_order_allocations a
      join inventory_lines i on i.id=a.inventory_line_id where a.order_id=$1 order by a.id`, [row.id]);
    if (APPLY && (finalOrder.status !== 'STAGED' || finalOrder.shippedAt
        || Number(finalOrder.routingTotalWeight) !== TOTAL_WEIGHT
        || JSON.stringify(finalOrder.pickedPalletDetails.map((p) => p.location)) !== JSON.stringify(PALLETS.map((p) => p.location))
        || finalAllocations.rows.some((a, i) => a.location !== PALLETS[i].location || a.sku !== SKU
          || a.lot_number !== LOT || Number(a.allocated_quantity) !== 1 || Number(a.quantity) < 1
          || a.account_name !== ACCOUNT || a.tracking_level !== 'PALLET'))) {
      throw new Error('Post-update verification failed.');
    }
    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ order: CODE, account: ACCOUNT, warehouse: WAREHOUSE_CODE,
      status: finalOrder.status, applied: APPLY, correctionRequired: sourceMode, alreadyCorrect: targetMode,
      sku: SKU, lot: LOT, pallets: PALLETS.map(({ palletNumber, location, weight }) =>
        ({ palletNumber, location, weightLb: weight })), totalWeightLb: TOTAL_WEIGHT, shipped: false }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release(); await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
