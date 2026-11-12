const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
} = require('../server');

const CODE = 'ORD-001396';
const ACCOUNT = 'ALCONA TRADING LTD';
const LOCATIONS = ['DI34AB', 'DI36AA', 'DI38AA', 'DI40AA'];
const WEIGHTS_LB = [2313, 2300, 2310, 2313];
const LB_TO_KG = 0.45359237;
const PALLETS = LOCATIONS.map((location, index) => ({
  palletNumber: index + 1,
  location,
  weight: Number((WEIGHTS_LB[index] * LB_TO_KG).toFixed(2)),
  weightUom: 'KG',
}));
const TOTAL_KG = Number((WEIGHTS_LB.reduce((a, b) => a + b, 0) * LB_TO_KG).toFixed(2));
const CARRIER = 'Bison Transport';
const DELIVERY_DATE = '2026-10-14';
const DELIVERY_TIME = '13:00';
const HANDLING_NOTE = 'Heat to 35 degrees Celsius for 2 hours before delivery.';
const APPOINTMENT_RECIPIENT = 'shipping.receiving@nutem.com';

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  let order;
  try {
    await client.query('begin');
    if (!apply) await client.query('set transaction read only');
    const found = await client.query(`select id,order_notes from portal_orders where order_code=$1
      ${apply ? 'for update' : ''}`, [CODE]);
    if (found.rowCount !== 1) throw new Error('Order identity is not unique.');
    order = await getPortalOrderById(client, found.rows[0].id, ACCOUNT);
    const allocations = await client.query(`select a.location,a.sku,a.lot_number,a.allocated_quantity
      from portal_order_allocations a where a.order_id=$1 order by a.id`, [order.id]);
    if (order.accountName !== ACCOUNT || String(order.fulfillmentLocationId) !== '143'
        || order.status !== 'STAGED' || order.shippedAt || order.poNumber !== '529672'
        || order.shippingReference !== 'S2607S00390117' || String(order.requestedShipDate).slice(0, 10) !== '2026-10-14'
        || order.lines.length !== 1 || order.lines[0].sku !== 'MS26062403' || Number(order.lines[0].quantity) !== 4
        || order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== 'STAGED'
        || allocations.rowCount !== 4 || allocations.rows.some((a, i) => a.location !== LOCATIONS[i]
          || a.sku !== 'MS26062403' || a.lot_number !== 'MS26062403' || Number(a.allocated_quantity) !== 1)) {
      throw new Error('Live order, allocations, or shipment state changed.');
    }
    if (apply) {
      const note = `Carrier ${CARRIER}. Delivery appointment October 14, 2026 at 1:00 PM ET. ${HANDLING_NOTE}`;
      const notesWithoutPriorAppointment = String(found.rows[0].order_notes || '').replace(
        /(?:^|\n)Carrier Bison Transport\. Delivery appointment October 14, 2026 at (?:11:00 AM|1:00 PM) ET\. Heat to 35 degrees Celsius for 2 hours before delivery\./g,
        '',
      ).trim();
      const notes = `${notesWithoutPriorAppointment}\n${note}`.trim();
      await client.query(`update portal_orders set order_notes=$2,shipped_carrier_name=$3,
        routing_total_weight=$4,routing_weight_uom='KG',routing_requested_delivery_date=$5::date,
        updated_at=now() where id=$1`, [order.id, notes, CARRIER, TOTAL_KG, DELIVERY_DATE]);
      const tokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
      const appointment = await client.query(`insert into order_routing_requests
        (order_id,token_hash,recipient_email,status,appointment_date,window_start,window_end,
         responder_name,responder_note,responded_at,expires_at)
        values($1,$2,$3,'CONFIRMED',$4::date,$5::time,null,
          'Owner-confirmed appointment','Appointment changed to 1:00 PM ET.',now(),now()+interval '14 days')
        on conflict(order_id) do update set status='CONFIRMED',appointment_date=excluded.appointment_date,
          window_start=excluded.window_start,window_end=null,
          responder_name=excluded.responder_name,responder_note=excluded.responder_note,
          responded_at=coalesce(order_routing_requests.responded_at,now()),updated_at=now()
        where order_routing_requests.status in ('PENDING','CONFIRMED') returning id`,
      [order.id, tokenHash, APPOINTMENT_RECIPIENT, DELIVERY_DATE, DELIVERY_TIME]);
      if (appointment.rowCount !== 1) throw new Error('The existing appointment request could not be updated safely.');
      await client.query(`update warehouse_shipments set carrier_name=$2,total_pallets=4,total_weight=$3,
        weight_uom='KG',delivery_date=$4::date,updated_at=now() where order_id=$1 and status='STAGED'`,
      [order.id, CARRIER, TOTAL_KG, DELIVERY_DATE]);
      await client.query('commit');
      order = {
        ...order,
        orderNotes: notes,
        shippedCarrierName: CARRIER,
        routingTotalWeight: TOTAL_KG,
        routingWeightUom: 'KG',
        routingAppointment: { status: 'CONFIRMED', appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME },
      };
    } else {
      await client.query('rollback');
    }
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release(); await pool.end();
  }
  const bolOrder = {
    ...order,
    pickedPalletDetails: PALLETS,
    routingTotalWeight: TOTAL_KG,
    routingWeightUom: 'KG',
    routingAppointment: { status: 'CONFIRMED', appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME },
    orderNotes: `Item and batch/lot MS26062403. ${HANDLING_NOTE} Delivery appointment confirmed for October 14, 2026 at 1:00 PM ET. PRE-SHIPMENT / UNSIGNED.`,
    warehouseShipments: order.warehouseShipments.map((shipment) => ({
      ...shipment,
      carrier: CARRIER,
      totalPallets: 4,
      totalWeight: TOTAL_KG,
      weightUom: 'KG',
      deliveryDate: DELIVERY_DATE,
      trackingReference: order.shippingReference,
    })),
  };
  const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
  if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(', ')}`);
  const attachment = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
  if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('BOL renderer returned invalid content.');
  console.log(JSON.stringify({ order: CODE, status: order.status, sku: 'MS26062403', lot: 'MS26062403',
    requestedShipDate: DELIVERY_DATE, deliveryTime: '1:00 PM ET', carrier: CARRIER,
    handlingNote: HANDLING_NOTE, applied: apply, pallets: PALLETS, totalWeightKg: TOTAL_KG,
    pdfSha256: crypto.createHash('sha256').update(attachment.content).digest('hex'),
    pdfBase64: attachment.content.toString('base64') }));
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
