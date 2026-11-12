const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
} = require('../server');

const CODE = 'ORD-001340';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const SKU = 'MS26060402G';
const BATCH = 'MS26062403';
const CARRIER = 'Truck 4 Delivery';
const DELIVERY_DATE = '2026-10-06';
const REPORTED = [
  { palletNumber: 1, location: 'DI34AA', weight: 2311, weightUom: 'LB' },
  { palletNumber: 2, location: 'DI14AB', weight: 2312, weightUom: 'LB' },
  { palletNumber: 3, location: 'DI16AB', weight: 2313, weightUom: 'LB' },
  { palletNumber: 4, location: 'DI28AA', weight: 2310, weightUom: 'LB' },
];
const ALLOCATED = ['DI10AC', 'DI12AC', 'DI14AC', 'DI16AC'];
const TOTAL_LB = REPORTED.reduce((sum, pallet) => sum + pallet.weight, 0);
const NOTE = `Warehouse reports batch/lot ${BATCH} for all four pallets; physical bins and weights: ${REPORTED.map(p => `${p.location} ${p.weight} lb`).join('; ')}. Inventory allocations remain in ${ALLOCATED.join(', ')} pending separate reconciliation; no stock moved. Truck 4 Delivery, delivery appointment reported for 2026-10-06 11:00 AM ET; receiver confirmation not independently verified.`;

function assertOrder(order) {
  if (!order || order.orderCode !== CODE || order.accountName !== ACCOUNT ||
      String(order.fulfillmentLocationId) !== WAREHOUSE_ID || order.status !== 'STAGED' || order.shippedAt ||
      order.lines.length !== 1 || order.lines[0].sku !== SKU || Number(order.lines[0].quantity) !== 4 ||
      order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== 'STAGED' ||
      Number(order.outboundPallets.totalPalletsOut) !== 4 ||
      order.poNumber !== '529672' || order.shippingReference !== 'S2607S00390117' ||
      order.shipToName !== 'NUTEM CUSTOM MANUFACTURING' || order.shipToAddress1 !== '1105 Clay Ave' ||
      order.shipToAddress2 !== 'Unit 7' || order.shipToCity !== 'Burlington') {
    throw new Error('Live order identity, destination, or staged quantity changed.');
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  let order;
  try {
    await client.query('BEGIN');
    if (!apply) await client.query('SET TRANSACTION READ ONLY');
    const found = await client.query(`SELECT id, account_name, fulfillment_location_id, status, shipped_at,
      order_notes, picked_pallet_details, routing_total_weight, routing_requested_delivery_date::text,
      shipped_carrier_name, requested_ship_date::text
      FROM portal_orders WHERE order_code=$1 ${apply ? 'FOR UPDATE' : ''}`, [CODE]);
    if (found.rowCount !== 1) throw new Error('Order not unique.');
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID ||
        row.status !== 'STAGED' || row.shipped_at ||
        String(row.requested_ship_date).slice(0, 10) !== DELIVERY_DATE) throw new Error('Order state changed.');
    order = await getPortalOrderById(client, row.id, ACCOUNT);
    assertOrder(order);
    if (row.shipped_carrier_name && row.shipped_carrier_name !== CARRIER) throw new Error('Order carrier conflicts.');
    if (order.warehouseShipments[0].carrier && order.warehouseShipments[0].carrier !== CARRIER) throw new Error('Shipment carrier conflicts.');
    if (row.routing_total_weight != null && Number(row.routing_total_weight) !== TOTAL_LB) throw new Error('Order weight conflicts.');
    if (row.routing_requested_delivery_date && row.routing_requested_delivery_date.slice(0, 10) !== DELIVERY_DATE) throw new Error('Delivery date conflicts.');
    const picked = (row.picked_pallet_details || []).map(p => p.location);
    if (JSON.stringify(picked) !== JSON.stringify(ALLOCATED)) throw new Error('Picked pallet record changed.');
    const allocation = await client.query(`SELECT a.location, a.sku, a.allocated_quantity, i.account_name, i.quantity
      FROM portal_order_allocations a JOIN inventory_lines i ON i.id=a.inventory_line_id
      WHERE a.order_id=$1 ORDER BY a.id`, [row.id]);
    if (allocation.rowCount !== 4 || allocation.rows.some((a, i) => a.location !== ALLOCATED[i] ||
        a.sku !== SKU || a.account_name !== ACCOUNT || Number(a.allocated_quantity) !== 1 || Number(a.quantity) !== 1)) {
      throw new Error('Inventory allocations changed.');
    }
    if (apply) {
      const notes = String(row.order_notes || '').includes(NOTE) ? row.order_notes : `${row.order_notes || ''}\n${NOTE}`.trim();
      await client.query(`UPDATE portal_orders SET order_notes=$2, shipped_carrier_name=$3,
        routing_total_weight=$4, routing_weight_uom='LB', routing_requested_delivery_date=$5::date,
        updated_at=now() WHERE id=$1`, [row.id, notes, CARRIER, TOTAL_LB, DELIVERY_DATE]);
      const changed = await client.query(`UPDATE warehouse_shipments SET carrier_name=$2, total_weight=$3,
        weight_uom='LB', delivery_date=$4::date, updated_at=now()
        WHERE order_id=$1 AND account_name=$5 AND fulfillment_location_id=$6 AND status='STAGED'
          AND (carrier_name IS NULL OR carrier_name='' OR carrier_name=$2)
        RETURNING id`, [row.id, CARRIER, TOTAL_LB, DELIVERY_DATE, ACCOUNT, WAREHOUSE_ID]);
      if (changed.rowCount !== 1) throw new Error('Staged shipment could not be updated safely.');
      order = await getPortalOrderById(client, row.id, ACCOUNT);
      assertOrder(order);
      if (!order.orderNotes.includes(NOTE) || order.shippedCarrierName !== CARRIER ||
          Number(order.routingTotalWeight) !== TOTAL_LB || order.warehouseShipments[0].carrier !== CARRIER) {
        throw new Error('Updated order failed readback.');
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  const bolOrder = {
    ...order,
    pickedPalletDetails: REPORTED,
    routingTotalWeight: TOTAL_LB,
    routingWeightUom: 'LB',
    routingAppointment: { status: 'REPORTED', appointmentDate: DELIVERY_DATE },
    orderNotes: `Batch / lot ${BATCH} for all four pallets (warehouse reported). Delivery appointment reported for Oct 6 at 11:00 AM ET; confirm with receiver. PRE-SHIPMENT / UNSIGNED.`,
    warehouseShipments: order.warehouseShipments.map(shipment => ({
      ...shipment,
      carrier: CARRIER,
      totalWeight: TOTAL_LB,
      weightUom: 'LB',
      deliveryDate: DELIVERY_DATE,
      trackingReference: order.shippingReference,
    })),
  };
  const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
  if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(', ')}`);
  const attachment = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
  if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('BOL renderer returned invalid content.');
  console.log(JSON.stringify({ order: CODE, status: order.status, applied: apply, batch: BATCH,
    carrier: CARRIER, reportedBins: REPORTED.map(p => p.location), allocatedBins: ALLOCATED,
    totalWeightLb: TOTAL_LB, pdfSha256: crypto.createHash('sha256').update(attachment.content).digest('hex'),
    pdfBase64: apply ? attachment.content.toString('base64') : undefined }));
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
