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
const CODE = 'ORD-001341';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const WAREHOUSE_CODE = 'WHS01';
const SKU = 'MS26062403';
const LOT = 'MS26062403';
const PALLETS = [
  { palletNumber: 1, from: 'DI18AC', location: 'DJ24AA', weight: 2319, weightUom: 'LB' },
  { palletNumber: 2, from: 'DI20AC', location: 'DJ34AA', weight: 2313, weightUom: 'LB' },
  { palletNumber: 3, from: 'DI22AC', location: 'DJ38AA', weight: 2314, weightUom: 'LB' },
  { palletNumber: 4, from: 'DI24AC', location: 'DJ40AA', weight: 2312, weightUom: 'LB' },
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
      from portal_orders o
      join fulfillment_locations fl on fl.id = o.fulfillment_location_id
      where o.order_code = $1
      ${APPLY ? 'for update of o' : ''}
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
      select a.id, a.inventory_line_id, a.location, a.sku, a.lot_number, a.allocated_quantity,
             i.account_name, i.quantity, i.upc, i.expiration_date, i.tracking_level
      from portal_order_allocations a
      join inventory_lines i on i.id = a.inventory_line_id
      where a.order_id = $1
      order by a.id
      ${APPLY ? 'for update of a, i' : ''}
    `, [row.id]);
    if (allocations.rowCount !== 4) throw new Error('Expected four pallet allocations.');
    const common = allocations.rows.every((allocation) => allocation.sku === SKU
      && allocation.lot_number === LOT && allocation.account_name === ACCOUNT
      && Number(allocation.allocated_quantity) === 1 && Number(allocation.quantity) === 1
      && allocation.tracking_level === 'PALLET');
    const sourceMode = common && allocations.rows.every((allocation, index) => allocation.location === PALLETS[index].from);
    const targetMode = common && allocations.rows.every((allocation, index) => allocation.location === PALLETS[index].location);
    if (!sourceMode && !targetMode) throw new Error('Allocation locations, lot, or quantities differ from review.');

    const pickedLocations = (row.picked_pallet_details || []).map((pallet) => pallet.location);
    const expectedPickedLocations = PALLETS.map((pallet) => sourceMode ? pallet.from : pallet.location);
    if (JSON.stringify(pickedLocations) !== JSON.stringify(expectedPickedLocations)) {
      throw new Error('Picked pallet details conflict with the active allocations.');
    }
    if (row.routing_total_weight != null && Number(row.routing_total_weight) !== TOTAL_WEIGHT) {
      throw new Error('Recorded total weight conflicts with the warehouse report.');
    }

    const bins = await client.query(`
      select code, is_pickable, fulfillment_location_id
      from bin_locations where upper(code) = any($1::text[])
    `, [PALLETS.map((pallet) => pallet.location)]);
    if (bins.rowCount !== 4 || bins.rows.some((bin) => !bin.is_pickable
        || (bin.fulfillment_location_id != null && String(bin.fulfillment_location_id) !== WAREHOUSE_ID))) {
      throw new Error(`One or more target bins are missing, non-pickable, or assigned to another warehouse: ${JSON.stringify(bins.rows)}`);
    }

    const targetInventory = await client.query(`
      select id, location, sku, lot_number, quantity, tracking_level
      from inventory_lines
      where account_name = $1 and sku = $2 and upper(location) = any($3::text[])
      order by location, id
      ${APPLY ? 'for update' : ''}
    `, [ACCOUNT, SKU, PALLETS.map((pallet) => pallet.location)]);
    const validTargets = targetInventory.rows.length === 4
      && targetInventory.rows.every((line) => line.lot_number === LOT && Number(line.quantity) === 1 && line.tracking_level === 'PALLET');
    if (sourceMode && targetInventory.rowCount && !validTargets) throw new Error('Target-bin inventory conflicts with the reported pallets.');

    if (APPLY && sourceMode && !validTargets) {
      for (let index = 0; index < PALLETS.length; index += 1) {
        const pallet = PALLETS[index];
        const allocation = allocations.rows[index];
        await upsertInventoryLine(client, {
          accountName: ACCOUNT,
          location: pallet.location,
          sku: SKU,
          upc: allocation.upc || '',
          lotNumber: LOT,
          expirationDate: allocation.expiration_date || '',
          trackingLevel: 'PALLET',
          quantity: 1,
        }, {
          transactionType: 'MOVE_LOCATION',
          sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION',
          sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id,
          appUser: ACTOR,
          source: 'web_admin',
          idempotencyKey: `${CODE}-${pallet.from}-to-${pallet.location}`,
        });
      }
      await reallocatePortalOrderToActualPalletLocations(client, order, PALLETS, ACTOR);
      for (let index = 0; index < PALLETS.length; index += 1) {
        const pallet = PALLETS[index];
        await safeDeductInventoryLineQuantity(client, allocations.rows[index].inventory_line_id, 1, {
          actionLabel: `record physical pallet move ${pallet.from} to ${pallet.location}`,
          transactionType: 'MOVE_LOCATION',
          sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION',
          sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id,
          appUser: ACTOR,
          source: 'web_admin',
          idempotencyKey: `${CODE}-${pallet.from}-to-${pallet.location}`,
        });
      }
    } else if (APPLY && sourceMode) {
      await reallocatePortalOrderToActualPalletLocations(client, order, PALLETS, ACTOR);
    }

    if (APPLY) {
      const notes = String(row.order_notes || '').includes(NOTE) ? row.order_notes : `${row.order_notes || ''}\n${NOTE}`.trim();
      await client.query(`
        update portal_orders
        set picked_pallet_details = $2::jsonb, routing_total_weight = $3,
            routing_weight_uom = 'LB', order_notes = $4, updated_at = now()
        where id = $1
      `, [row.id, JSON.stringify(PALLETS.map(({ palletNumber, location, weight, weightUom }) => ({ palletNumber, location, weight, weightUom }))), TOTAL_WEIGHT, notes]);
      await updateWarehouseShipmentDetail(client, order.warehouseShipments[0].id, {
        status: 'STAGED', totalPallets: 4, totalWeight: TOTAL_WEIGHT, weightUom: 'LB',
      }, { accountName: ACCOUNT, actor: ACTOR.full_name });
    }

    const finalOrder = await getPortalOrderById(client, row.id, ACCOUNT);
    const finalAllocations = await client.query(`
      select a.location, a.sku, a.lot_number, a.allocated_quantity, i.quantity, i.account_name, i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id = a.inventory_line_id
      where a.order_id = $1 order by a.id
    `, [row.id]);
    if (APPLY && (finalOrder.status !== 'STAGED' || finalOrder.shippedAt
        || Number(finalOrder.routingTotalWeight) !== TOTAL_WEIGHT
        || JSON.stringify(finalOrder.pickedPalletDetails.map((pallet) => pallet.location)) !== JSON.stringify(PALLETS.map((pallet) => pallet.location))
        || finalAllocations.rows.some((allocation, index) => allocation.location !== PALLETS[index].location
          || allocation.sku !== SKU || allocation.lot_number !== LOT || Number(allocation.allocated_quantity) !== 1
          || Number(allocation.quantity) !== 1 || allocation.account_name !== ACCOUNT || allocation.tracking_level !== 'PALLET'))) {
      throw new Error('Post-update verification failed.');
    }

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({
      order: CODE,
      account: ACCOUNT,
      warehouse: WAREHOUSE_CODE,
      status: finalOrder.status,
      applied: APPLY,
      correctionRequired: sourceMode,
      alreadyCorrect: targetMode,
      sku: SKU,
      lot: LOT,
      pallets: PALLETS.map(({ palletNumber, location, weight }) => ({ palletNumber, location, weightLb: weight })),
      totalWeightLb: TOTAL_WEIGHT,
      emailsSent: false,
      shipped: false,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
