const crypto = require('node:crypto');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const ORDER_ID = 1341;
const CODE = 'ORD-001341';
const ACCOUNT = 'ALCONA TRADING LTD';
const TO = 'shipping.receiving@nutem.com';
const CC = ['smit@alconatradingltd.ca', 'gworders@greywolf3pl.com'];
const DELIVERY_DATE = '2026-10-09';
const DELIVERY_TIME = '11:00 AM ET';
const TOTAL_PALLETS = 4;
const TOTAL_WEIGHT_KG = 4199.4;
const DELIVERY_KEY = `order-routing:${ORDER_ID}`;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  let logId = null;
  try {
    await client.query('BEGIN');
    if (!APPLY) await client.query('SET TRANSACTION READ ONLY');
    const orderResult = await client.query(`
      select o.*, s.status as shipment_status
      from portal_orders o join warehouse_shipments s on s.order_id = o.id
      where o.id = $1 and o.order_code = $2
      ${APPLY ? 'for update of o, s' : ''}
    `, [ORDER_ID, CODE]);
    if (orderResult.rowCount !== 1) throw new Error('Order identity is not unique.');
    const order = orderResult.rows[0];
    if (order.account_name !== ACCOUNT || String(order.fulfillment_location_id) !== '143'
        || order.status !== 'STAGED' || order.shipment_status !== 'STAGED' || order.shipped_at
        || order.routed_at || Number(order.outbound_total_pallets) !== TOTAL_PALLETS
        || Number(order.routing_total_weight) !== 9258 || order.routing_weight_uom !== 'LB') {
      throw new Error('Order routing state changed.');
    }
    const lines = await client.query(`
      select l.sku, l.requested_quantity, count(a.id)::integer as allocations,
             sum(a.allocated_quantity)::integer as allocated_quantity,
             array_agg(a.location order by a.id) as locations,
             array_agg(a.lot_number order by a.id) as lots
      from portal_order_lines l join portal_order_allocations a on a.order_line_id = l.id
      where l.order_id = $1 group by l.id, l.sku, l.requested_quantity
    `, [ORDER_ID]);
    if (lines.rowCount !== 1 || lines.rows[0].sku !== 'MS26062403'
        || Number(lines.rows[0].requested_quantity) !== 4 || Number(lines.rows[0].allocations) !== 4
        || Number(lines.rows[0].allocated_quantity) !== 4
        || JSON.stringify(lines.rows[0].locations) !== JSON.stringify(['DJ24AA', 'DJ34AA', 'DJ38AA', 'DJ40AA'])
        || lines.rows[0].lots.some((lot) => lot !== 'MS26062403')) {
      throw new Error('Order allocations changed.');
    }

    const existing = await client.query('select id, status from email_delivery_log where delivery_key = $1 limit 1', [DELIVERY_KEY]);
    if (existing.rowCount) throw new Error(`Appointment request already has a ${existing.rows[0].status} delivery record.`);

    const subject = `Delivery appointment request - PO ${order.po_number} - Friday, October 9, 2026 at 11:00 AM ET`;
    const body = [
      'Good evening,',
      '',
      'Can you please confirm a delivery appointment for the following shipment:',
      '',
      `Requested appointment: Friday, October 9, 2026 at ${DELIVERY_TIME}`,
      `PO: ${order.po_number}`,
      `WMS order: ${CODE}`,
      `Total pallets: ${TOTAL_PALLETS}`,
      `Total weight: ${TOTAL_WEIGHT_KG.toFixed(1)} kg`,
      '',
      'Delivery address:',
      order.ship_to_name,
      order.ship_to_address1,
      order.ship_to_address2,
      `${order.ship_to_city}, ${order.ship_to_state} ${order.ship_to_postal_code}`,
      order.ship_to_country,
      '',
      'Please use the secure link below to confirm the appointment window.',
      '{{APPOINTMENT_URL}}',
      '',
      'Thank you,',
      '',
      'Grey Wolf 3PL & Logistics Inc.',
    ].filter((line) => line !== undefined && line !== null).join('\n');

    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ order: CODE, ready: true, to: TO, cc: CC, subject,
        requestedAppointment: `${DELIVERY_DATE} ${DELIVERY_TIME}`, pallets: TOTAL_PALLETS,
        totalWeightKg: TOTAL_WEIGHT_KG, sent: false }));
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const origin = String(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://app.wms365.co').replace(/\/+$/, '');
    const appointmentUrl = `${origin}/order-routing-appointment?token=${encodeURIComponent(token)}`;
    const text = body.replace('{{APPOINTMENT_URL}}', appointmentUrl);
    const html = `<div style="font-family:Arial,sans-serif;color:#17324d;line-height:1.5;max-width:680px">${text.split(/\r?\n/).map((line) => line === appointmentUrl
      ? `<p><a href="${escapeHtml(appointmentUrl)}" style="display:inline-block;padding:11px 16px;background:#17677d;color:#fff;text-decoration:none;font-weight:700">Confirm Delivery Appointment</a></p>`
      : line ? `<p style="margin:0 0 10px">${escapeHtml(line)}</p>` : '<div style="height:6px"></div>').join('')}</div>`;

    const requestResult = await client.query(`
      insert into order_routing_requests(order_id, token_hash, recipient_email)
      values ($1, $2, $3) returning id
    `, [ORDER_ID, tokenHash, TO]);
    const logResult = await client.query(`
      insert into email_delivery_log (
        status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
        reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
      ) values ('PENDING', 'RESEND', $1, $2::jsonb, $3::jsonb, '[]'::jsonb,
        $4, $5, $6, 'ORDER_ROUTING', $7, $8, $9::jsonb)
      returning id
    `, [process.env.SMTP_FROM || 'WMS365 <support@wms365.co>', JSON.stringify([TO]), JSON.stringify(CC),
      process.env.SMTP_REPLY_TO || '', subject, ACCOUNT, CODE, DELIVERY_KEY,
      JSON.stringify({ orderId: ORDER_ID, requestedAppointment: `${DELIVERY_DATE} ${DELIVERY_TIME}`, routingRequestId: requestResult.rows[0].id })]);
    logId = logResult.rows[0].id;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.SMTP_FROM || 'WMS365 <support@wms365.co>',
        to: [TO], cc: CC,
        reply_to: process.env.SMTP_REPLY_TO || undefined,
        subject, text, html,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const providerResult = await response.json().catch(() => ({}));
    if (!response.ok || !providerResult.id) throw new Error(`Resend rejected appointment request: ${providerResult.message || response.statusText}`);

    await client.query(`
      update email_delivery_log set status='SENT', message_id=$2, provider_response=$3,
        sent_at=now(), updated_at=now() where id=$1
    `, [logId, providerResult.id, `Resend accepted email with status ${response.status}`]);
    await client.query(`
      update portal_orders set routing_email=$2, routing_requested_delivery_date=$3::date,
        routed_at=now(), routed_by=$4, updated_at=now() where id=$1
    `, [ORDER_ID, TO, DELIVERY_DATE, 'Owner-requested appointment routing']);
    await client.query('COMMIT');

    const verify = await pool.query(`
      select o.order_code, o.status, o.routed_at, o.routing_email,
             o.routing_requested_delivery_date::text as requested_date,
             e.status as email_status, e.to_addresses, e.cc_addresses, e.message_id,
             r.status as appointment_status
      from portal_orders o
      join email_delivery_log e on e.delivery_key=$2
      join order_routing_requests r on r.order_id=o.id and r.id=$3
      where o.id=$1
    `, [ORDER_ID, DELIVERY_KEY, requestResult.rows[0].id]);
    const saved = verify.rows[0];
    if (!saved || saved.status !== 'STAGED' || saved.email_status !== 'SENT'
        || saved.appointment_status !== 'PENDING' || saved.routing_email !== TO
        || JSON.stringify(saved.to_addresses) !== JSON.stringify([TO])
        || JSON.stringify(saved.cc_addresses) !== JSON.stringify(CC)) {
      throw new Error('Post-send verification failed.');
    }
    console.log(JSON.stringify({ order: CODE, status: saved.status, sent: true, to: TO, cc: CC,
      subject, requestedAppointment: `${DELIVERY_DATE} ${DELIVERY_TIME}`, emailStatus: saved.email_status,
      appointmentStatus: saved.appointment_status, messageId: saved.message_id }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (logId) {
      await pool.query(`update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1`, [logId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    }
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
