const { Pool } = require('pg');
const {
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
} = require('../server');

const CODE = 'ORD-001340';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const BATCH = 'MS26062403';
const OLD = ['DI10AC', 'DI12AC', 'DI14AC', 'DI16AC'];
const PALLETS = [
  { palletNumber: 1, location: 'DI34AA', weight: 2311, weightUom: 'LB' },
  { palletNumber: 2, location: 'DI14AB', weight: 2312, weightUom: 'LB' },
  { palletNumber: 3, location: 'DI16AB', weight: 2313, weightUom: 'LB' },
  { palletNumber: 4, location: 'DI28AA', weight: 2310, weightUom: 'LB' },
];
const PREFIX = `Warehouse-confirmed physical pick bins and batch/lot ${BATCH}: ${PALLETS.map(p => `${p.location} ${p.weight} lb`).join('; ')}. Pre-shipment, unsigned. Inventory allocations remain at ${OLD.join(', ')} pending separate reconciliation.`;

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!apply) await client.query('SET TRANSACTION READ ONLY');
    const q = await client.query(`SELECT o.id,o.status,o.account_name,o.fulfillment_location_id,o.shipped_at,
      o.picked_pallet_details,o.order_notes,o.routing_total_weight,o.shipped_carrier_name,
      o.requested_ship_date::text AS requested_ship_date,
      s.status AS shipment_status,s.carrier_name AS shipment_carrier,s.total_weight AS shipment_weight
      FROM portal_orders o JOIN warehouse_shipments s ON s.order_id=o.id
      WHERE o.order_code=$1 ${apply ? 'FOR UPDATE OF o,s' : ''}`, [CODE]);
    if (q.rowCount !== 1) throw new Error('Order or shipment not unique.');
    const row = q.rows[0];
    if (row.status !== 'STAGED' || row.shipment_status !== 'STAGED' || row.shipped_at ||
        row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID ||
        row.shipped_carrier_name !== 'Truck 4 Delivery' || row.shipment_carrier !== 'Truck 4 Delivery' ||
        Number(row.routing_total_weight) !== 9246 || Number(row.shipment_weight) !== 9246 ||
        row.requested_ship_date.slice(0, 10) !== '2026-10-06') throw new Error('Staged order details changed.');
    const order = await getPortalOrderById(client, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== 'MS26060402G' || Number(order.lines[0].quantity) !== 4 ||
        !String(row.order_notes || '').includes(BATCH)) throw new Error('SKU, quantity, or batch note changed.');
    const locations = (row.picked_pallet_details || []).map(p => p.location);
    const isOld = JSON.stringify(locations) === JSON.stringify(OLD);
    const isNew = JSON.stringify(locations) === JSON.stringify(PALLETS.map(p => p.location));
    if (!isOld && !isNew) throw new Error('Physical pick bins changed since review.');
    const allocations = await client.query(`SELECT a.location,a.sku,a.allocated_quantity,i.quantity,i.account_name
      FROM portal_order_allocations a JOIN inventory_lines i ON i.id=a.inventory_line_id
      WHERE a.order_id=$1 ORDER BY a.id`, [row.id]);
    if (allocations.rowCount !== 4 || allocations.rows.some((a, i) => a.location !== OLD[i] || a.sku !== 'MS26060402G' ||
      Number(a.allocated_quantity) !== 1 || Number(a.quantity) !== 1 || a.account_name !== ACCOUNT)) {
      throw new Error('Inventory allocations changed.');
    }
    if (apply) {
      const notes = String(row.order_notes || '').startsWith(PREFIX) ? row.order_notes : `${PREFIX}\n${row.order_notes || ''}`.trim();
      await client.query(`UPDATE portal_orders SET picked_pallet_details=$2::jsonb,order_notes=$3,updated_at=now()
        WHERE id=$1`, [row.id, JSON.stringify(PALLETS), notes]);
      const updated = await getPortalOrderById(client, row.id, ACCOUNT);
      const verifiedPallets = updated.pickedPalletDetails || [];
      if (verifiedPallets.length !== PALLETS.length ||
          verifiedPallets.some((p, i) => p.location !== PALLETS[i].location ||
            Number(p.weight) !== PALLETS[i].weight || p.weightUom !== 'LB') ||
          !updated.orderNotes.startsWith(PREFIX) || updated.status !== 'STAGED') {
        throw new Error('Updated pick record failed verification.');
      }
      const pdfOrder = {
        ...updated,
        routingAppointment: { status: 'REPORTED', appointmentDate: '2026-10-06' },
        orderNotes: `Batch / lot ${BATCH} for all four pallets (warehouse reported). Delivery appointment reported for Oct 6 at 11:00 AM ET; confirm with receiver. PRE-SHIPMENT / UNSIGNED.`,
        warehouseShipments: updated.warehouseShipments.map(s => ({ ...s, trackingReference: updated.shippingReference })),
      };
      const readiness = getPortalOrderBillOfLadingReadiness(pdfOrder);
      if (!readiness.ready) throw new Error(`BOL readiness failed: ${readiness.missingFields.join(', ')}`);
      const attachment = buildPortalOrderBillOfLadingPdfAttachment(pdfOrder);
      if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('Invalid system BOL PDF.');
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ order: CODE, status: 'STAGED', applied: apply,
      physicalPickBins: PALLETS.map(p => p.location), inventoryAllocationBins: OLD,
      inventoryMoved: false, otherOrdersChanged: false }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
