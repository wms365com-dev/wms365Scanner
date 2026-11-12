const crypto = require('node:crypto');
const { Client } = require('pg');

const CODE = 'ORD-001341';
const ACCOUNT = 'ALCONA TRADING LTD';
const FILENAME = 'WMS365_BOL_ORD-001341_2026-10-09.pdf';
const DELIVERY_KEY = 'owner-ord-001341-bol-dhruv-gworders-20261008-kg-v1';
const FROM = 'WMS365 <support@wms365.co>';
const TO = ['d.jain@emotrans-canada.com'];
const CC = ['gworders@greywolf3pl.com'];
const SUBJECT = 'BOL - Alcona ORD-001341 / PO 529672 - Oct 9, 11 AM delivery';
const LOCATIONS = ['DJ24AA', 'DJ34AA', 'DJ38AA', 'DJ40AA'];
const WEIGHTS_KG = [1051.88, 1049.16, 1049.62, 1048.71];

async function main(pdfBase64, expectedHash, apply = false) {
  if (!process.env.RESEND_API_KEY) throw new Error('Email provider unavailable.');
  const pdf = Buffer.from(String(pdfBase64 || ''), 'base64');
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  if (pdf.subarray(0, 4).toString() !== '%PDF' || pdf.length < 1000 || hash !== expectedHash) {
    throw new Error('Reviewed BOL attachment hash mismatch.');
  }
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let logId;
  let documentId;
  try {
    await db.query('BEGIN');
    try {
      const q = await db.query(`select o.id,o.account_name,o.status,o.shipped_at,o.fulfillment_location_id,
        o.po_number,o.shipping_reference,o.shipped_carrier_name,o.routing_total_weight,o.routing_weight_uom,
        o.picked_pallet_details,o.order_notes,s.id as shipment_id,s.status as shipment_status,
        s.carrier_name as shipment_carrier,s.total_weight as shipment_weight,s.weight_uom as shipment_weight_uom,
        s.delivery_date::text as delivery_date
        from portal_orders o join warehouse_shipments s on s.order_id=o.id
        where o.order_code=$1 for update of o,s`, [CODE]);
      if (q.rowCount !== 1) throw new Error('Order or shipment identity is not unique.');
      const o = q.rows[0];
      if (o.account_name !== ACCOUNT || o.status !== 'STAGED' || o.shipment_status !== 'STAGED' || o.shipped_at
          || String(o.fulfillment_location_id) !== '143' || o.po_number !== '529672'
          || o.shipping_reference !== 'S2607S00390117' || o.shipped_carrier_name !== 'Bison Reefer'
          || o.shipment_carrier !== 'Bison Reefer' || Number(o.routing_total_weight) !== 4199.4
          || Number(o.shipment_weight) !== 4199.4 || o.routing_weight_uom !== 'KG'
          || o.shipment_weight_uom !== 'KG' || String(o.delivery_date).slice(0, 10) !== '2026-10-09'
          || !String(o.order_notes || '').includes('30 degrees Celsius')) throw new Error('Live order or BOL details changed.');
      const pallets = o.picked_pallet_details || [];
      if (pallets.length !== 4 || pallets.some((p, i) => p.location !== LOCATIONS[i])) throw new Error('Pick bins changed.');
      const lines = await db.query(`select l.sku,l.requested_quantity,count(a.id)::integer allocations,
        sum(a.allocated_quantity)::numeric allocated,array_agg(a.lot_number order by a.id) lots
        from portal_order_lines l join portal_order_allocations a on a.order_line_id=l.id
        where l.order_id=$1 group by l.id,l.sku,l.requested_quantity`, [o.id]);
      if (lines.rowCount !== 1 || lines.rows[0].sku !== 'MS26062403' || Number(lines.rows[0].requested_quantity) !== 4
          || Number(lines.rows[0].allocations) !== 4 || Number(lines.rows[0].allocated) !== 4
          || lines.rows[0].lots.some((lot) => lot !== 'MS26062403')) throw new Error('Order lines or lot allocations changed.');
      const recipientProof = await db.query(`select id from email_delivery_log where status='SENT'
        and (to_addresses @> $1::jsonb or cc_addresses @> $1::jsonb or bcc_addresses @> $1::jsonb)
        limit 1`, [JSON.stringify(TO)]);
      if (recipientProof.rowCount !== 1) throw new Error('Dhruv recipient identity could not be verified from prior sent mail.');
      const previous = await db.query('select status,message_id from email_delivery_log where delivery_key=$1', [DELIVERY_KEY]);
      if (previous.rowCount) {
        if (previous.rows[0].status === 'SENT') {
          await db.query('ROLLBACK');
          console.log(JSON.stringify({ order: CODE, alreadySent: true, messageId: previous.rows[0].message_id }));
          return;
        }
        throw new Error('A prior email attempt requires review; refusing a duplicate send.');
      }
      const existing = await db.query('select id,file_data from portal_order_documents where order_id=$1 and file_name=$2', [o.id, FILENAME]);
      if (existing.rowCount > 1 || (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(pdf))) {
        throw new Error('Existing BOL attachment conflicts with the reviewed PDF.');
      }
      if (!apply) {
        await db.query('ROLLBACK');
        console.log(JSON.stringify({ order: CODE, ready: true, to: TO, cc: CC, pdfSha256: hash,
          existingAttachment: existing.rowCount === 1, duplicate: false }));
        return;
      }
      if (existing.rowCount) documentId = existing.rows[0].id;
      else {
        const inserted = await db.query(`insert into portal_order_documents
          (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
          values($1,$2,'application/pdf',$3,$4,'GENERAL',$5,$6) returning id`,
          [o.id, FILENAME, pdf.length, pdf, 'WMS365 Support - unsigned pre-shipment BOL', o.shipment_id]);
        documentId = inserted.rows[0].id;
      }
      const claim = await db.query(`insert into email_delivery_log
        (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
         account_name,source_type,source_ref,delivery_key,metadata)
        values('PENDING','RESEND',$1,$2::jsonb,$3::jsonb,'[]'::jsonb,$4,$5,$6,
          'PORTAL_ORDER_BOL',$7,$8,$9::jsonb) on conflict(delivery_key) do nothing returning id`,
        [FROM, JSON.stringify(TO), JSON.stringify(CC), 'support@wms365.co', SUBJECT, ACCOUNT, CODE,
          DELIVERY_KEY, JSON.stringify({ pdfSha256: hash, filename: FILENAME, documentId,
            carrier: 'Bison Reefer', totalKg: 4199.4, deliveryDate: '2026-10-09', deliveryTimeEt: '11:00' })]);
      if (claim.rowCount !== 1) throw new Error('BOL email idempotency claim failed.');
      logId = claim.rows[0].id;
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const body = [
      'Hello Dhruv,', '',
      'Attached is the unsigned pre-shipment BOL for Alcona order ORD-001341 (PO 529672).',
      'The BOL shows item and batch/lot MS26062403, four pallets totaling 4,199.4 kg, and the confirmed delivery appointment for October 9 at 11:00 AM Eastern.',
      'Carrier: Bison Reefer. Special instruction: hold for 2 hours at 30 degrees Celsius before delivery.',
      'The order remains staged and has not been marked shipped.', '',
      'Regards,', 'Grey Wolf 3PL & Logistics Inc.'
    ].join('\n');
    const response = await fetch(`${(process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': DELIVERY_KEY },
      body: JSON.stringify({ from: FROM, to: TO, cc: CC, reply_to: 'support@wms365.co', subject: SUBJECT,
        text: body, attachments: [{ filename: FILENAME, content: pdf.toString('base64') }] }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      await db.query(`update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
        [logId, `Provider rejected BOL (${response.status})`]);
      throw new Error(`Provider did not accept BOL email (${response.status}).`);
    }
    await db.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
      sent_at=now(),updated_at=now() where id=$1`, [logId, payload.id, 'Resend accepted BOL with PDF attachment']);
    const final = await db.query(`select o.status,o.shipped_at,e.status email_status,e.message_id,e.to_addresses,e.cc_addresses,d.file_data
      from portal_orders o join email_delivery_log e on e.delivery_key=$2
      join portal_order_documents d on d.order_id=o.id and d.file_name=$3 where o.order_code=$1`, [CODE, DELIVERY_KEY, FILENAME]);
    const checked = final.rows[0];
    if (final.rowCount !== 1 || checked.status !== 'STAGED' || checked.shipped_at || checked.email_status !== 'SENT'
        || checked.message_id !== payload.id || JSON.stringify(checked.to_addresses) !== JSON.stringify(TO)
        || JSON.stringify(checked.cc_addresses) !== JSON.stringify(CC)
        || crypto.createHash('sha256').update(checked.file_data).digest('hex') !== hash) {
      throw new Error('Email accepted but final WMS verification failed.');
    }
    console.log(JSON.stringify({ order: CODE, status: checked.status, emailStatus: checked.email_status,
      messageId: checked.message_id, to: TO, cc: CC, documentId, pdfSha256: hash }));
  } finally {
    await db.end();
  }
}

module.exports = { main };
