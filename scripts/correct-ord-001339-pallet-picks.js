const { Pool } = require('pg');
const {
  APP_USER_ROLES,
  getPortalOrderById,
  reallocatePortalOrderToActualPalletLocations,
  safeDeductInventoryLineQuantity,
  updateWarehouseShipmentDetail,
  upsertInventoryLine,
} = require('/app/server.js');

const apply = process.argv.includes('--apply');
const code = 'ORD-001339';
const account = 'ALCONA TRADING LTD';
const sku = 'MS26060402G';
const pallets = [
  { palletNumber: 1, from: 'DI04AC', location: 'DI20AA', weight: 2312, weightUom: 'LB' },
  { palletNumber: 2, from: 'DI06AA', location: 'DI22AA', weight: 2309, weightUom: 'LB' },
  { palletNumber: 3, from: 'DI06AC', location: 'DI24AA', weight: 2309, weightUom: 'LB' },
  { palletNumber: 4, from: 'DI08AC', location: 'DI26AA', weight: 2310, weightUom: 'LB' },
];
const totalWeight = pallets.reduce((sum, pallet) => sum + pallet.weight, 0);
const note = `Physical pick bins and tote weights confirmed by warehouse: ${pallets.map(p => `${p.location} ${p.weight} lb`).join('; ')}.`;
const actor = { id: null, email: 'prathab@greywolf3pl.com', full_name: 'Owner-confirmed pick location correction', role: APP_USER_ROLES.SUPER_ADMIN };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!apply) await client.query('SET TRANSACTION READ ONLY');
    const found = await client.query(`select o.*,fl.code as warehouse from portal_orders o
      join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1 ${apply ? 'for update of o' : ''}`, [code]);
    if (found.rowCount !== 1) throw new Error('Order identity not unique');
    const row = found.rows[0];
    if (row.account_name !== account || row.warehouse !== 'WHS01' || String(row.fulfillment_location_id) !== '143' ||
      row.status !== 'STAGED' || row.shipped_at || Number(row.outbound_total_pallets) !== 4 ||
      row.shipped_carrier_name || row.shipped_tracking_reference) throw new Error('Order identity or shipping state changed');
    const order = await getPortalOrderById(client, row.id, account);
    if (order.lines.length !== 1 || order.lines[0].sku !== sku || Number(order.lines[0].quantity) !== 4 ||
      order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== 'STAGED') throw new Error('Order lines or shipment changed');
    const allocations = await client.query(`select a.id,a.inventory_line_id,a.location,a.sku,a.allocated_quantity,
      i.account_name,i.quantity,i.upc,i.lot_number,i.expiration_date,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id ${apply ? 'for update of a,i' : ''}`, [row.id]);
    if (allocations.rowCount !== 4) throw new Error('Expected four allocations');
    const common = allocations.rows.every(a => a.sku === sku && a.account_name === account && Number(a.allocated_quantity) === 1 && Number(a.quantity) === 1 && a.tracking_level === 'PALLET');
    const sourceMode = common && allocations.rows.every((a, i) => a.location === pallets[i].from);
    const targetMode = common && allocations.rows.every((a, i) => a.location === pallets[i].location);
    if (!sourceMode && !targetMode) throw new Error('Allocation locations or quantities differ from review');
    const oldLocations = (row.picked_pallet_details || []).map(p => p.location);
    const expectedLocations = pallets.map(p => sourceMode ? p.from : p.location);
    if (JSON.stringify(oldLocations) !== JSON.stringify(expectedLocations)) throw new Error('Picked details conflict with allocations');
    if (row.routing_total_weight != null && Number(row.routing_total_weight) !== totalWeight) throw new Error('Recorded weight conflicts');
    const occupied = await client.query('select location,sku,account_name,quantity from inventory_lines where upper(location)=any($1::text[])', [pallets.map(p => p.location)]);
    if (sourceMode && occupied.rowCount) throw new Error('Target bin occupied');
    const bins = await client.query('select code,is_pickable from bin_locations where code=any($1::text[])', [pallets.map(p => p.location)]);
    if (bins.rowCount !== 4 || bins.rows.some(b => !b.is_pickable)) throw new Error('Target bins invalid');
    if (apply && sourceMode) {
      for (let i = 0; i < pallets.length; i++) {
        const p = pallets[i], a = allocations.rows[i];
        await upsertInventoryLine(client, { accountName: account, location: p.location, sku,
          upc: a.upc || '', lotNumber: a.lot_number || '', expirationDate: a.expiration_date || '',
          trackingLevel: a.tracking_level, quantity: 1 }, { transactionType: 'MOVE_LOCATION',
          sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION', sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id, appUser: actor, source: 'web_admin',
          idempotencyKey: `${code}-${p.from}-to-${p.location}` });
      }
      await reallocatePortalOrderToActualPalletLocations(client, order, pallets, actor);
      for (let i = 0; i < pallets.length; i++) {
        const p = pallets[i];
        await safeDeductInventoryLineQuantity(client, allocations.rows[i].inventory_line_id, 1, {
          actionLabel: `record physical pallet move ${p.from} to ${p.location}`,
          transactionType: 'MOVE_LOCATION', sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION',
          sourceId: row.id, fulfillmentLocationId: row.fulfillment_location_id, appUser: actor,
          source: 'web_admin', idempotencyKey: `${code}-${p.from}-to-${p.location}` });
      }
    }
    if (apply) {
      const updatedNotes = String(row.order_notes || '').includes(note) ? row.order_notes : `${row.order_notes || ''}\n${note}`.trim();
      await client.query(`update portal_orders set picked_pallet_details=$2::jsonb,routing_total_weight=$3,
        routing_weight_uom='LB',order_notes=$4,updated_at=now() where id=$1`,
        [row.id, JSON.stringify(pallets.map(({ palletNumber, location, weight, weightUom }) => ({ palletNumber, location, weight, weightUom }))), totalWeight, updatedNotes]);
      await updateWarehouseShipmentDetail(client, order.warehouseShipments[0].id, {
        status: 'STAGED', totalPallets: 4, totalWeight, weightUom: 'LB'
      }, { accountName: account, actor: actor.full_name });
      const updated = await getPortalOrderById(client, row.id, account);
      if (updated.status !== 'STAGED' || updated.shippedAt || Number(updated.routingTotalWeight) !== totalWeight ||
        JSON.stringify(updated.pickedPalletDetails.map(p => p.location)) !== JSON.stringify(pallets.map(p => p.location)))
        throw new Error('Post-update verification failed');
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ order: code, status: 'STAGED', corrected: apply && sourceMode,
      alreadyCorrect: targetMode, pallets: pallets.map(({ palletNumber, location, weight }) => ({ palletNumber, location, weightLb: weight })), totalWeightLb: totalWeight }));
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
