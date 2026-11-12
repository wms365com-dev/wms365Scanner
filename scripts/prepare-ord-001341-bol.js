const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
  updateWarehouseShipmentDetail,
} = require('../server');

const CODE = 'ORD-001341';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const SKU = 'MS26062403';
const LOT = 'MS26062403';
const CARRIER = 'Bison Reefer';
const DELIVERY_DATE = '2026-10-09';
const PALLETS = [
  { palletNumber: 1, location: 'DJ24AA', weight: 1051.88, weightUom: 'KG' },
  { palletNumber: 2, location: 'DJ34AA', weight: 1049.16, weightUom: 'KG' },
  { palletNumber: 3, location: 'DJ38AA', weight: 1049.62, weightUom: 'KG' },
  { palletNumber: 4, location: 'DJ40AA', weight: 1048.71, weightUom: 'KG' },
];
const TOTAL_KG = 4199.40;
const HOLD_NOTE = 'Hold for 2 hours at 30 degrees Celsius before delivery.';
const NOTE = `Carrier ${CARRIER}. ${HOLD_NOTE} Delivery appointment Friday, October 9, 2026 at 11:00 AM ET. SKU and batch/lot ${LOT}.`;

function assertOrder(order) {
  if (!order || order.orderCode !== CODE || order.accountName !== ACCOUNT
      || String(order.fulfillmentLocationId) !== WAREHOUSE_ID || order.status !== 'STAGED'
      || order.shippedAt || order.lines.length !== 1 || order.lines[0].sku !== SKU
      || Number(order.lines[0].quantity) !== 4 || order.warehouseShipments.length !== 1
      || order.warehouseShipments[0].status !== 'STAGED'
      || Number(order.outboundPallets.totalPalletsOut) !== 4) {
    throw new Error('Live order identity, staged quantity, or shipment state changed.');
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
    const found = await client.query(`select id, account_name, fulfillment_location_id, status, shipped_at,
      order_notes, picked_pallet_details, routing_total_weight, routing_weight_uom,
      routing_requested_delivery_date::text, shipped_carrier_name
      from portal_orders where order_code=$1 ${apply ? 'for update' : ''}`, [CODE]);
    if (found.rowCount !== 1) throw new Error('Order identity is not unique.');
    const row = found.rows[0];
    order = await getPortalOrderById(client, row.id, ACCOUNT);
    assertOrder(order);
    const allocations = await client.query(`select a.location, a.sku, a.lot_number, a.allocated_quantity,
      i.account_name, i.quantity, i.tracking_level from portal_order_allocations a
      join inventory_lines i on i.id=a.inventory_line_id where a.order_id=$1 order by a.id`, [row.id]);
    if (allocations.rowCount !== 4 || allocations.rows.some((allocation, index) =>
      allocation.location !== PALLETS[index].location || allocation.sku !== SKU || allocation.lot_number !== LOT
      || allocation.account_name !== ACCOUNT || Number(allocation.allocated_quantity) !== 1
      || Number(allocation.quantity) !== 1 || allocation.tracking_level !== 'PALLET')) {
      throw new Error('Corrected pallet allocations are not ready for the BOL.');
    }
    const storedWeightIsExpected = row.routing_total_weight == null
      || (row.routing_weight_uom === 'LB' && Number(row.routing_total_weight) === 9258)
      || (row.routing_weight_uom === 'KG' && Number(row.routing_total_weight) === TOTAL_KG);
    if (!storedWeightIsExpected) throw new Error('Total weight conflicts with the reviewed shipment.');
    if (apply) {
      const notes = String(row.order_notes || '').includes(NOTE) ? row.order_notes : `${row.order_notes || ''}\n${NOTE}`.trim();
      await client.query(`update portal_orders set order_notes=$2, shipped_carrier_name=$3,
        routing_total_weight=$4, routing_weight_uom='KG', routing_requested_delivery_date=$5::date,
        updated_at=now() where id=$1`,
        [row.id, notes, CARRIER, TOTAL_KG, DELIVERY_DATE]);
      const appointment = await client.query(`update order_routing_requests set status='CONFIRMED',
        appointment_date=$2::date, window_start='11:00', window_end=null,
        responder_name='Owner-confirmed appointment', responder_note='Appointment tomorrow at 11:00 AM ET.',
        responded_at=coalesce(responded_at, now()), updated_at=now()
        where order_id=$1 and status in ('PENDING','CONFIRMED') returning id`, [row.id, DELIVERY_DATE]);
      if (appointment.rowCount !== 1) throw new Error('The existing appointment request could not be updated safely.');
      await updateWarehouseShipmentDetail(client, order.warehouseShipments[0].id, {
        status: 'STAGED', carrierName: CARRIER, totalPallets: 4, totalWeight: TOTAL_KG,
        weightUom: 'KG', deliveryDate: DELIVERY_DATE,
      }, { accountName: ACCOUNT, actor: 'Owner-requested BOL preparation' });
      order = await getPortalOrderById(client, row.id, ACCOUNT);
      assertOrder(order);
      if (!order.orderNotes.includes(NOTE) || order.shippedCarrierName !== CARRIER
          || Number(order.routingTotalWeight) !== TOTAL_KG || order.routingWeightUom !== 'KG'
          || order.routingAppointment?.status !== 'CONFIRMED'
          || order.routingAppointment?.windowStart !== '11:00') throw new Error('BOL details failed readback.');
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
    pickedPalletDetails: PALLETS,
    routingTotalWeight: TOTAL_KG,
    routingWeightUom: 'KG',
    routingAppointment: { status: 'CONFIRMED', appointmentDate: DELIVERY_DATE, windowStart: '11:00' },
    orderNotes: `Item and batch/lot ${LOT}. ${HOLD_NOTE} Delivery appointment confirmed for October 9, 2026 at 11:00 AM ET. PRE-SHIPMENT / UNSIGNED.`,
    warehouseShipments: order.warehouseShipments.map((shipment) => ({
      ...shipment, carrier: CARRIER, totalWeight: TOTAL_KG, weightUom: 'KG', deliveryDate: DELIVERY_DATE,
      trackingReference: order.shippingReference,
    })),
  };
  const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
  if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(', ')}`);
  const attachment = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
  if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('BOL renderer returned invalid content.');
  console.log(JSON.stringify({ order: CODE, status: order.status, applied: apply, carrier: CARRIER,
    sku: SKU, lot: LOT, deliveryDate: DELIVERY_DATE, deliveryTime: '11:00 AM ET', holdNote: HOLD_NOTE,
    pallets: PALLETS, totalWeightKg: TOTAL_KG,
    pdfSha256: crypto.createHash('sha256').update(attachment.content).digest('hex'),
    pdfBase64: apply ? attachment.content.toString('base64') : undefined }));
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
