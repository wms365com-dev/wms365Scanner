const crypto = require('node:crypto');
const { Client } = require('pg');

const CODE = 'ORD-001395';
const ACCOUNT = 'ALCONA TRADING LTD';
const FILENAME = 'WMS365_BOL_ORD-001395_2026-10-20_10AM_BISON.pdf';
const DELIVERY_KEY = 'owner-ord-001395-bol-dhruv-20261020-10am-bison-v1';
const FROM = 'WMS365 <support@wms365.co>';
const TO = ['d.jain@emotrans-canada.com'];
const SUBJECT = 'Revised pre-shipment BOL - Alcona ORD-001395 / PO 529673 - Oct 20, by 10 AM';
const LOCATIONS = ['DJ44AC', 'DJ42AC', 'DJ40AC', 'DJ38AC'];
const TOTAL_KG = 4203.89;

async function main(pdfBase64, expectedHash, apply = false) {
  if (!process.env.RESEND_API_KEY) throw new Error('Email provider unavailable.');
  const pdf = Buffer.from(String(pdfBase64 || ''), 'base64');
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  if (pdf.subarray(0, 4).toString() !== '%PDF' || pdf.length < 1000 || hash !== expectedHash) throw new Error('Reviewed BOL hash mismatch.');
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let logId;
  try {
    await db.query('begin');
    const q = await db.query(`select o.*,s.id shipment_id,s.status shipment_status,s.carrier_name shipment_carrier,
      s.total_weight shipment_weight,s.weight_uom shipment_weight_uom,s.delivery_date::text delivery_date
      from portal_orders o join warehouse_shipments s on s.order_id=o.id where o.order_code=$1 for update of o,s`, [CODE]);
    if (q.rowCount !== 1) throw new Error('Order or shipment identity is not unique.');
    const o = q.rows[0];
    if (o.account_name !== ACCOUNT || o.status !== 'STAGED' || o.shipment_status !== 'STAGED' || o.shipped_at
        || String(o.fulfillment_location_id) !== '143' || o.po_number !== '529673'
        || o.shipped_carrier_name !== 'Bison Transport' || o.shipment_carrier !== 'Bison Transport'
        || Number(o.routing_total_weight) !== TOTAL_KG || Number(o.shipment_weight) !== TOTAL_KG
        || o.routing_weight_uom !== 'KG' || o.shipment_weight_uom !== 'KG'
        || String(o.delivery_date).slice(0, 10) !== '2026-10-20') throw new Error('Live order or BOL details changed.');
    const pallets = o.picked_pallet_details || [];
    if (pallets.length !== 4 || pallets.some((p, i) => p.location !== LOCATIONS[i] || p.weightUom !== 'KG')) throw new Error('Pick bins or weight units changed.');
    const allocations = await db.query(`select a.location,a.sku,a.lot_number,a.allocated_quantity,i.quantity
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id`, [o.id]);
    if (allocations.rowCount !== 4 || allocations.rows.some((a, i) => a.location !== LOCATIONS[i]
        || a.sku !== 'MS26062403' || a.lot_number !== 'MS26062403'
        || Number(a.allocated_quantity) !== 1 || Number(a.quantity) < 1)) throw new Error('Allocations changed.');
    const recipientProof = await db.query(`select id from email_delivery_log where status='SENT'
      and (to_addresses @> $1::jsonb or cc_addresses @> $1::jsonb or bcc_addresses @> $1::jsonb) limit 1`, [JSON.stringify(TO)]);
    if (recipientProof.rowCount !== 1) throw new Error('Dhruv recipient identity could not be verified.');
    const previous = await db.query('select status,message_id from email_delivery_log where delivery_key=$1', [DELIVERY_KEY]);
    if (previous.rowCount) {
      await db.query('rollback');
      if (previous.rows[0].status === 'SENT') return console.log(JSON.stringify({ alreadySent: true, messageId: previous.rows[0].message_id }));
      throw new Error('A prior email attempt requires review.');
    }
    const existing = await db.query('select id,file_data from portal_order_documents where order_id=$1 and file_name=$2', [o.id, FILENAME]);
    if (existing.rowCount > 1 || (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(pdf))) throw new Error('Existing BOL conflicts with reviewed PDF.');
    if (!apply) {
      await db.query('rollback');
      return console.log(JSON.stringify({ ready: true, toCount: TO.length, ccCount: 0, bccCount: 0, pdfSha256: hash }));
    }
    await db.query(`delete from portal_order_documents where order_id=$1 and file_name='WMS365_BOL_ORD-001395_2026-10-19_1PM.pdf' and document_category='GENERAL'`, [o.id]);
    if (!existing.rowCount) await db.query(`insert into portal_order_documents
      (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
      values($1,$2,'application/pdf',$3,$4,'GENERAL',$5,$6)`,
    [o.id, FILENAME, pdf.length, pdf, 'WMS365 Support - unsigned pre-shipment BOL', o.shipment_id]);
    const claim = await db.query(`insert into email_delivery_log
      (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
       account_name,source_type,source_ref,delivery_key,metadata)
      values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,'[]'::jsonb,$3,$4,$5,'PORTAL_ORDER_BOL',$6,$7,$8::jsonb)
      on conflict(delivery_key) do nothing returning id`,
    [FROM, JSON.stringify(TO), 'support@wms365.co', SUBJECT, ACCOUNT, CODE, DELIVERY_KEY,
      JSON.stringify({ pdfSha256: hash, filename: FILENAME, carrier: 'Bison Transport', carrierConfirmationNeeded: false,
        totalKg: TOTAL_KG, deliveryDate: '2026-10-20', deliveryTimeEt: '10:00' })]);
    if (claim.rowCount !== 1) throw new Error('Email idempotency claim failed.');
    logId = claim.rows[0].id;
    await db.query('commit');

    const body = ['Hello Dhruv,', '',
      'Attached is the revised pre-shipment BOL for Alcona order ORD-001395 (PO 529673), for delivery October 20, 2026 by 10:00 AM ET.', '',
      'Regards,', 'Grey Wolf 3PL & Logistics Inc.'].join('\n');
    const response = await fetch(`${(process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': DELIVERY_KEY },
      body: JSON.stringify({ from: FROM, to: TO, subject: SUBJECT, reply_to: 'support@wms365.co', text: body,
        attachments: [{ filename: FILENAME, content: pdf.toString('base64') }] }), signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      await db.query(`update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`, [logId, `Provider rejected BOL (${response.status})`]);
      throw new Error(`Provider did not accept BOL email (${response.status}).`);
    }
    await db.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,sent_at=now(),updated_at=now() where id=$1`,
    [logId, payload.id, 'Resend accepted BOL with PDF attachment']);
    const final = await db.query(`select status,message_id,to_addresses,cc_addresses,bcc_addresses from email_delivery_log where id=$1`, [logId]);
    const e = final.rows[0];
    if (e.status !== 'SENT' || e.message_id !== payload.id || e.to_addresses.length !== 1 || e.cc_addresses.length || e.bcc_addresses.length) throw new Error('Final email verification failed.');
    console.log(JSON.stringify({ order: CODE, status: 'STAGED', emailStatus: e.status, messageId: e.message_id,
      toCount: e.to_addresses.length, ccCount: 0, bccCount: 0, pdfSha256: hash }));
  } finally { await db.end(); }
}

module.exports = { main };
