const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildPortalOrderBillOfLadingPdfAttachment, getPortalOrderById } = require('/app/server.js');

const CODE = 'ORD-001395';
const ACCOUNT = 'ALCONA TRADING LTD';
const LOCATIONS = ['DJ44AC', 'DJ42AC', 'DJ40AC', 'DJ38AC'];
const DELIVERY_DATE = '2026-10-20';
const DELIVERY_TIME = '10:00';
const CARRIER = 'Bison Transport';
const APPLY = process.argv.includes('--apply');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (!APPLY) await client.query('set transaction read only');
    const found = await client.query('select id from portal_orders where order_code=$1', [CODE]);
    if (found.rowCount !== 1) throw new Error('Order identity is not unique.');
    const order = await getPortalOrderById(client, found.rows[0].id, ACCOUNT);
    const allocations = await client.query(`select location,sku,lot_number,allocated_quantity
      from portal_order_allocations where order_id=$1 order by id`, [order.id]);
    if (order.status !== 'STAGED' || order.shippedAt || order.poNumber !== '529673'
        || Number(order.routingTotalWeight) !== 4203.89 || order.routingWeightUom !== 'KG'
        || allocations.rowCount !== 4 || allocations.rows.some((a, i) => a.location !== LOCATIONS[i]
          || a.sku !== 'MS26062403' || a.lot_number !== 'MS26062403' || Number(a.allocated_quantity) !== 1)) {
      throw new Error('Live staged order details changed.');
    }
    if (APPLY) {
      await client.query(`update portal_orders set routing_requested_delivery_date=$2::date,
        requested_ship_date=$2::date,shipped_carrier_name=$3,updated_at=now() where id=$1`,
      [order.id, DELIVERY_DATE, CARRIER]);
      await client.query(`update warehouse_shipments set delivery_date=$2::date,carrier_name=$3,updated_at=now()
        where order_id=$1 and status='STAGED'`, [order.id, DELIVERY_DATE, CARRIER]);
      const routing = await client.query(`update order_routing_requests set status='PENDING',appointment_date=$2::date,
        window_start=$3::time,window_end=null,responder_name='',
        responder_note='Owner requested delivery by 10:00 AM ET on October 20, 2026.',responded_at=null,updated_at=now()
        where order_id=$1 returning id`, [order.id, DELIVERY_DATE, DELIVERY_TIME]);
      if (routing.rowCount !== 1) throw new Error('Expected one routing request to update.');
      await client.query('commit');
    } else await client.query('rollback');
    const bolOrder = { ...order, shippedCarrierName: CARRIER, shippedTrackingReference: '',
      orderNotes: 'Requested delivery on October 20, 2026 by 10:00 AM ET.',
      routingRequestedDeliveryDate: DELIVERY_DATE, requestedShipDate: DELIVERY_DATE,
      routingAppointment: { status: 'PENDING', appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME },
      warehouseShipments: order.warehouseShipments.map(s => ({ ...s, status: 'STAGED', carrier: CARRIER,
        trackingReference: '', totalPallets: 4, existingPallets: 4, newPallets: 0, mixedPallets: 0,
        totalWeight: 4203.89, weightUom: 'KG', deliveryDate: DELIVERY_DATE, shippedAt: null })) };
    const attachment = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('Invalid BOL PDF.');
    console.log(JSON.stringify({ order: CODE, applied: APPLY, status: order.status, carrier: CARRIER, comments: '',
      deliveryDate: DELIVERY_DATE, deliveryTimeEt: DELIVERY_TIME, totalWeightKg: 4203.89,
      pdfSha256: crypto.createHash('sha256').update(attachment.content).digest('hex'), pdfBase64: attachment.content.toString('base64') }));
  } finally { client.release(); await pool.end(); }
}

module.exports = { main };
