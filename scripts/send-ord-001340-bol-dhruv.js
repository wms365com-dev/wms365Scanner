const crypto = require('node:crypto');
const { Client } = require('pg');

const CODE = 'ORD-001340';
const ACCOUNT = 'ALCONA TRADING LTD';
const FILENAME = 'WMS365_BOL_ORD-001340_REVISED_KG_2DP.pdf';
const DELIVERY_KEY = 'owner-ord-001340-bol-dhruv-20261005-kg-11am-v1';
const FROM = 'WMS365 <support@wms365.co>';
const TO = ['support@wms365.co'];
const BCC = ['d.jain@emotrans-canada.com'];
const SUBJECT = 'BOL - Alcona ORD-001340 / PO 529672 - Oct 6, 11 AM delivery';
const LOCATIONS = ['DI34AA', 'DI14AB', 'DI16AB', 'DI28AA'];
const WEIGHTS = [2311, 2312, 2313, 2310];

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
      const q = await db.query(`SELECT o.id,o.account_name,o.status,o.shipped_at,o.fulfillment_location_id,
        o.po_number,o.shipping_reference,o.requested_ship_date::text,o.shipped_carrier_name,
        o.routing_total_weight,o.picked_pallet_details,o.order_notes,
        s.id AS shipment_id,s.status AS shipment_status,s.carrier_name AS shipment_carrier,
        s.total_weight AS shipment_weight,s.delivery_date::text AS delivery_date
        FROM portal_orders o JOIN warehouse_shipments s ON s.order_id=o.id
        WHERE o.order_code=$1 FOR UPDATE OF o,s`, [CODE]);
      if (q.rowCount !== 1) throw new Error('Order or shipment identity not unique.');
      const o = q.rows[0];
      if (o.account_name !== ACCOUNT || o.status !== 'STAGED' || o.shipment_status !== 'STAGED' || o.shipped_at ||
          String(o.fulfillment_location_id) !== '143' || o.po_number !== '529672' ||
          o.shipping_reference !== 'S2607S00390117' ||
          String(o.requested_ship_date).slice(0, 10) !== '2026-10-06' ||
          String(o.delivery_date).slice(0, 10) !== '2026-10-06' ||
          o.shipped_carrier_name !== 'Truck 4 Delivery' || o.shipment_carrier !== 'Truck 4 Delivery' ||
          Number(o.routing_total_weight) !== 9246 || Number(o.shipment_weight) !== 9246 ||
          !String(o.order_notes || '').includes('MS26062403')) throw new Error('Live order or delivery details changed.');
      const pallets = o.picked_pallet_details || [];
      if (pallets.length !== 4 || pallets.some((p, i) => p.location !== LOCATIONS[i] || Number(p.weight) !== WEIGHTS[i])) {
        throw new Error('Physical pick bins or weights changed.');
      }
      const lines = await db.query('SELECT sku,requested_quantity FROM portal_order_lines WHERE order_id=$1', [o.id]);
      if (lines.rowCount !== 1 || lines.rows[0].sku !== 'MS26060402G' || Number(lines.rows[0].requested_quantity) !== 4) {
        throw new Error('Underlying order line changed.');
      }
      const proof = await db.query(`SELECT id FROM email_delivery_log WHERE source_type='PORTAL_ORDER_BOL'
        AND source_ref='ORD-001339' AND status='SENT' AND bcc_addresses @> $1::jsonb LIMIT 1`, [JSON.stringify(BCC)]);
      if (proof.rowCount !== 1) throw new Error('Prior Dhruv BOL recipient proof missing.');
      const previous = await db.query('SELECT status,message_id FROM email_delivery_log WHERE delivery_key=$1', [DELIVERY_KEY]);
      if (previous.rowCount) {
        if (previous.rows[0].status === 'SENT') {
          await db.query('ROLLBACK');
          console.log(JSON.stringify({ order: CODE, alreadySent: true, messageId: previous.rows[0].message_id }));
          return;
        }
        throw new Error('Prior BOL email attempt requires review; refusing duplicate send.');
      }
      const existing = await db.query('SELECT id,file_data FROM portal_order_documents WHERE order_id=$1 AND file_name=$2', [o.id, FILENAME]);
      if (existing.rowCount > 1 || (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(pdf))) {
        throw new Error('Existing BOL attachment conflicts with reviewed revision.');
      }
      if (!apply) {
        await db.query('ROLLBACK');
        console.log(JSON.stringify({ order: CODE, status: o.status, recipientVerified: true,
          pdfSha256: hash, existingAttachment: existing.rowCount === 1, duplicate: false }));
        return;
      }
      if (existing.rowCount) documentId = existing.rows[0].id;
      else {
        const inserted = await db.query(`INSERT INTO portal_order_documents
          (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
          VALUES($1,$2,'application/pdf',$3,$4,'GENERAL',$5,$6) RETURNING id`,
          [o.id, FILENAME, pdf.length, pdf, 'WMS365 Support - revised unsigned pre-shipment BOL', o.shipment_id]);
        documentId = inserted.rows[0].id;
      }
      const claim = await db.query(`INSERT INTO email_delivery_log
        (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
         subject,account_name,source_type,source_ref,delivery_key,metadata)
        VALUES('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,
               'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
        ON CONFLICT(delivery_key) DO NOTHING RETURNING id`,
        [FROM, JSON.stringify(TO), JSON.stringify(BCC), 'support@wms365.co', SUBJECT,
          ACCOUNT, CODE, DELIVERY_KEY, JSON.stringify({ pdfSha256: hash, filename: FILENAME,
            documentId, carrier: 'Truck 4 Delivery', orderStatus: 'STAGED', pallets: 4,
            totalKg: 4193.92, deliveryDate: '2026-10-06', deliveryTimeEt: '11:00' })]);
      if (claim.rowCount !== 1) throw new Error('BOL email idempotency claim failed.');
      logId = claim.rows[0].id;
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const body = [
      'Hello Dhruv,', '',
      'Attached is the revised unsigned pre-shipment BOL for Alcona order ORD-001340 (PO 529672).',
      'The BOL shows item / batch MS26062403, four pallets totaling 4,193.92 kg, and delivery on October 6 at 11:00 AM Eastern as advised by the owner.',
      'Please use this revision in place of any earlier version. The order is staged, not yet marked shipped; carrier pickup and receiver confirmation are not evidenced by this BOL.',
      '', 'Regards,', 'Grey Wolf 3PL & Logistics Inc.'
    ].join('\n');
    const response = await fetch(`${(process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': DELIVERY_KEY },
      body: JSON.stringify({ from: FROM, to: TO, bcc: BCC, reply_to: 'support@wms365.co', subject: SUBJECT, text: body,
        attachments: [{ filename: FILENAME, content: pdf.toString('base64') }] }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      await db.query(`UPDATE email_delivery_log SET status='FAILED',error_message=$2,failed_at=now(),updated_at=now() WHERE id=$1`,
        [logId, `Provider rejected BOL (${response.status})`]);
      throw new Error(`Provider did not accept BOL email (${response.status}).`);
    }
    await db.query(`UPDATE email_delivery_log SET status='SENT',message_id=$2,provider_response=$3,
      sent_at=now(),updated_at=now() WHERE id=$1`, [logId, payload.id, 'Resend accepted revised BOL with PDF attachment']);
    const final = await db.query(`SELECT o.status,o.shipped_at,e.status AS email_status,e.message_id,e.bcc_addresses,
      d.file_data FROM portal_orders o JOIN email_delivery_log e ON e.delivery_key=$2
      JOIN portal_order_documents d ON d.order_id=o.id AND d.file_name=$3 WHERE o.order_code=$1`,
      [CODE, DELIVERY_KEY, FILENAME]);
    const checked = final.rows[0];
    if (final.rowCount !== 1 || checked.status !== 'STAGED' || checked.shipped_at ||
        checked.email_status !== 'SENT' || checked.message_id !== payload.id ||
        JSON.stringify(checked.bcc_addresses) !== JSON.stringify(BCC) ||
        crypto.createHash('sha256').update(checked.file_data).digest('hex') !== hash) {
      throw new Error('Email accepted but final WMS verification failed.');
    }
    console.log(JSON.stringify({ order: CODE, status: checked.status, emailStatus: checked.email_status,
      messageId: checked.message_id, bccCount: BCC.length, documentId, pdfSha256: hash }));
  } finally {
    await db.end();
  }
}

module.exports = { main };
