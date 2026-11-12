const crypto = require('node:crypto');
const { Client } = require('pg');

const code = 'ORD-001339';
const account = 'ALCONA TRADING LTD';
const key = 'owner-ord-001339-preship-bol-dhruv-20260930-v1';
const from = 'WMS365 <support@wms365.co>';
const to = ['support@wms365.co'];
const bcc = ['d.jain@emotrans-canada.com'];
const filename = 'WMS365_BOL_ORD-001339_PRE_SHIPMENT.pdf';
const subject = 'Pre-shipment BOL - Alcona ORD-001339 / PO 529672';
const locations = ['DI20AA', 'DI22AA', 'DI24AA', 'DI26AA'];
const weights = [2312, 2309, 2309, 2310];

async function main(pdfBase64, expectedHash, apply) {
  if (!process.env.RESEND_API_KEY) throw new Error('Email provider unavailable');
  const pdf = Buffer.from(String(pdfBase64 || ''), 'base64');
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  if (pdf.subarray(0, 4).toString() !== '%PDF' || hash !== expectedHash || pdf.length < 1000)
    throw new Error('Reviewed PDF hash mismatch');
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  let logId;
  let documentId;
  try {
    await db.query('BEGIN');
    try {
      const q = await db.query(`select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
        o.shipped_at,o.shipped_carrier_name,o.po_number,o.shipping_reference,
        o.requested_ship_date::text as requested_ship_date,o.routing_total_weight,o.routing_weight_uom,
        o.outbound_total_pallets,o.picked_pallet_details from portal_orders o where o.order_code=$1 for update`, [code]);
      const o = q.rows[0];
      if (q.rowCount !== 1 || o.account_name !== account || o.status !== 'STAGED' ||
        String(o.fulfillment_location_id) !== '143' || o.shipped_at || o.shipped_carrier_name ||
        o.po_number !== '529672' || o.shipping_reference !== 'S2607S00390117' ||
        String(o.requested_ship_date).slice(0, 10) !== '2026-10-02' ||
        Number(o.routing_total_weight) !== 9240 || o.routing_weight_uom !== 'LB' ||
        Number(o.outbound_total_pallets) !== 4) throw new Error('Order state changed since BOL review');
      const pallets = o.picked_pallet_details || [];
      if (pallets.length !== 4 || pallets.some((p, i) => p.location !== locations[i] || Number(p.weight) !== weights[i]))
        throw new Error('Pallet details changed');
      const lines = await db.query('select sku,requested_quantity from portal_order_lines where order_id=$1', [o.id]);
      if (lines.rowCount !== 1 || lines.rows[0].sku !== 'MS26060402G' || Number(lines.rows[0].requested_quantity) !== 4)
        throw new Error('Order SKU or quantity changed');
      const shipment = await db.query(`select id,status,account_name,fulfillment_location_id,carrier_name,
        total_pallets,total_weight,weight_uom from warehouse_shipments where order_id=$1 for update`, [o.id]);
      const s = shipment.rows[0];
      if (shipment.rowCount !== 1 || s.status !== 'STAGED' || s.account_name !== account ||
        String(s.fulfillment_location_id) !== '143' || s.carrier_name || Number(s.total_pallets) !== 4 ||
        Number(s.total_weight) !== 9240 || s.weight_uom !== 'LB') throw new Error('Shipment state changed');
      const proof = await db.query(`select id from email_delivery_log where source_type='PORTAL_ORDER_BOL'
        and source_ref='ORD-001338' and status='SENT' and bcc_addresses @> $1::jsonb limit 1`, [JSON.stringify(bcc)]);
      if (proof.rowCount !== 1) throw new Error('Prior Dhruv BOL recipient proof missing');
      const previous = await db.query('select status,message_id from email_delivery_log where delivery_key=$1', [key]);
      if (previous.rowCount) {
        if (previous.rows[0].status === 'SENT') {
          await db.query('ROLLBACK');
          console.log(JSON.stringify({ alreadySent: true, messageId: previous.rows[0].message_id }));
          return;
        }
        throw new Error('Prior email attempt needs review; refusing duplicate');
      }
      const existing = await db.query('select id,file_data from portal_order_documents where order_id=$1 and file_name=$2', [o.id, filename]);
      if (existing.rowCount > 1 || (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(pdf)))
        throw new Error('Existing BOL document conflicts');
      if (!apply) {
        await db.query('ROLLBACK');
        console.log(JSON.stringify({ order: code, status: o.status, recipientVerified: true,
          pdfSha256: hash, existingAttachment: existing.rowCount === 1, duplicate: false }));
        return;
      }
      if (existing.rowCount) documentId = existing.rows[0].id;
      else {
        const d = await db.query(`insert into portal_order_documents
          (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
          values($1,$2,'application/pdf',$3,$4,'GENERAL',$5,$6) returning id`,
          [o.id, filename, pdf.length, pdf, 'WMS365 Support - unsigned pre-shipment BOL', s.id]);
        documentId = d.rows[0].id;
      }
      const claim = await db.query(`insert into email_delivery_log
        (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
         subject,account_name,source_type,source_ref,delivery_key,metadata)
        values('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5,$6,
               'PORTAL_ORDER_BOL',$7,$8,$9::jsonb)
        on conflict(delivery_key) do nothing returning id`,
        [from, JSON.stringify(to), JSON.stringify(bcc), 'support@wms365.co', subject,
          account, code, key, JSON.stringify({ pdfSha256: hash, filename, documentId,
            carrier: 'UNASSIGNED', orderStatus: 'STAGED', pallets: 4, weightLb: 9240 })]);
      if (claim.rowCount !== 1) throw new Error('Email idempotency claim failed');
      logId = claim.rows[0].id;
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }

    const body = [
      'Hello Dhruv,', '',
      'Attached is the unsigned pre-shipment BOL for Alcona order ORD-001339 (PO 529672).',
      'The order is staged, not shipped. The carrier has not yet been assigned, and freight terms and signatures remain open.',
      'Four pallets / four totes total 4,191.19 kg. Individual tote weights and corrected pick bins are on the BOL.',
      'Requested ship date: October 2, 2026. Shipping reference: S2607S00390117.',
      'Please confirm the delivery appointment with Nutem receiving before dispatch and inspect the totes for damage.',
      '', 'Regards,', 'Grey Wolf 3PL & Logistics Inc.'
    ].join('\n');
    const response = await fetch(`${(process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from, to, bcc, reply_to: 'support@wms365.co', subject, text: body,
        attachments: [{ filename, content: pdf.toString('base64') }] }),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id) {
      await db.query(`update email_delivery_log set status='FAILED',error_message=$2,
        failed_at=now(),updated_at=now() where id=$1`, [logId, `Provider rejected BOL (${response.status})`]);
      throw new Error(`BOL email not accepted (${response.status})`);
    }
    await db.query(`update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
      sent_at=now(),updated_at=now() where id=$1`, [logId, payload.id, 'Resend accepted BOL with PDF attachment']);
    const check = await db.query(`select o.status,o.shipped_at,e.status as email_status,e.message_id,e.bcc_addresses
      from portal_orders o join email_delivery_log e on e.delivery_key=$2 where o.order_code=$1`, [code, key]);
    const result = check.rows[0];
    if (check.rowCount !== 1 || result.status !== 'STAGED' || result.shipped_at ||
      result.email_status !== 'SENT' || result.message_id !== payload.id ||
      JSON.stringify(result.bcc_addresses) !== JSON.stringify(bcc))
      throw new Error('Provider accepted email but post-send verification failed');
    console.log(JSON.stringify({ order: code, status: result.status, emailStatus: result.email_status,
      messageId: result.message_id, bccCount: bcc.length, documentId, pdfSha256: hash }));
  } finally { await db.end(); }
}

module.exports = { main };
