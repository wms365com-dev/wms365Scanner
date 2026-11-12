const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
  preparePortalOrderBillOfLading,
} = require('../server');

const CODE = 'ORD-001472';
const ACCOUNT = 'ZETA GROUP (CANADA) LTD.';
const WAREHOUSE_ID = '1';
const WAREHOUSE_CODE = 'GW3PL-MISS';
const CARRIER = 'OMAR';
const PALLETS = 1;
const TOTAL_WEIGHT = 500;
const WEIGHT_UOM = 'LB';
const DELIVERY_DATE = '2026-10-16';
const WINDOW_START = '08:00';
const WINDOW_END = '12:00';
const FILENAME = `${CODE}-OMAR-BOL.pdf`;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'outputs', 'bol', FILENAME);

function assertExactOrder(order) {
  if (!order || order.orderCode !== CODE || order.accountName !== ACCOUNT
      || String(order.fulfillmentLocationId) !== WAREHOUSE_ID
      || order.status !== 'STAGED' || order.shippedAt
      || order.poNumber !== '239335' || order.shippingReference !== '239335'
      || order.shipmentMethod !== 'LTL_FREIGHT'
      || order.lines.length !== 4 || order.warehouseShipments.length !== 1
      || order.warehouseShipments[0].status !== 'STAGED') {
    throw new Error('Order identity, warehouse, status, or shipment scope changed.');
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  let result;
  try {
    await client.query('begin');
    if (!apply) await client.query('set transaction read only');
    const found = await client.query(
      `select id, order_notes from portal_orders where order_code=$1 ${apply ? 'for update' : ''}`,
      [CODE],
    );
    if (found.rowCount !== 1) throw new Error('Order identity is not unique.');
    let order = await getPortalOrderById(client, found.rows[0].id, ACCOUNT);
    assertExactOrder(order);

    const allocation = await client.query(`
      select l.sku, l.requested_quantity,
             coalesce(sum(a.allocated_quantity), 0)::integer allocated_quantity
      from portal_order_lines l
      left join portal_order_allocations a on a.order_line_id=l.id
      where l.order_id=$1 group by l.id order by l.id
    `, [order.id]);
    if (allocation.rowCount !== 4 || allocation.rows.some((line) => (
      Number(line.requested_quantity) <= 0
      || Number(line.requested_quantity) !== Number(line.allocated_quantity)
    ))) throw new Error('Order is no longer fully allocated.');

    const existing = await client.query(
      `select id, file_name, file_data from portal_order_documents
       where order_id=$1 and document_category='SHIPMENT_BOL' order by id`,
      [order.id],
    );
    if (existing.rowCount > 1) throw new Error('Multiple existing BOL documents require review.');

    if (apply) {
      const note = `Carrier ${CARRIER}. One pallet, ${TOTAL_WEIGHT} ${WEIGHT_UOM}. Delivery appointment October 16, 2026 between 8:00 AM and 12:00 PM ET.`;
      const notes = String(found.rows[0].order_notes || '').includes(note)
        ? found.rows[0].order_notes
        : `${found.rows[0].order_notes || ''}\n${note}`.trim();
      await client.query('update portal_orders set order_notes=$2, updated_at=now() where id=$1', [order.id, notes]);

      await preparePortalOrderBillOfLading(client, order, order, {
        shipments: [{
          shipmentId: order.warehouseShipments[0].id,
          shipmentMethod: 'LTL_FREIGHT',
          carrier: CARRIER,
          totalPallets: PALLETS,
          totalWeight: TOTAL_WEIGHT,
          weightUom: WEIGHT_UOM,
          deliveryDate: DELIVERY_DATE,
          bolReference: `BOL-${CODE}`,
        }],
      }, { full_name: 'Owner-approved BOL preparation' });

      const tokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
      await client.query(`
        insert into order_routing_requests
          (order_id, token_hash, recipient_email, status, appointment_date,
           window_start, window_end, responder_name, responder_note, responded_at, expires_at)
        values ($1,$2,'gue_receiving@well.ca','CONFIRMED',$3::date,$4::time,$5::time,
          'Owner-confirmed appointment','Delivery window confirmed by owner.',now(),now()+interval '14 days')
        on conflict(order_id) do update set status='CONFIRMED', appointment_date=excluded.appointment_date,
          window_start=excluded.window_start, window_end=excluded.window_end,
          responder_name=excluded.responder_name, responder_note=excluded.responder_note,
          responded_at=coalesce(order_routing_requests.responded_at,now()), updated_at=now()
        where order_routing_requests.status in ('PENDING','CONFIRMED')
      `, [order.id, tokenHash, DELIVERY_DATE, WINDOW_START, WINDOW_END]);

      order = await getPortalOrderById(client, order.id, ACCOUNT);
      assertExactOrder(order);
      const readiness = getPortalOrderBillOfLadingReadiness(order);
      if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(', ')}`);
      const attachment = buildPortalOrderBillOfLadingPdfAttachment(order);
      if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('BOL renderer returned invalid content.');

      if (existing.rowCount === 1 && !Buffer.from(existing.rows[0].file_data).equals(attachment.content)) {
        throw new Error('An existing BOL conflicts with the reviewed document.');
      }
      if (!existing.rowCount) {
        await client.query(`
          insert into portal_order_documents
            (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
          values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)
        `, [order.id, FILENAME, attachment.content.length, attachment.content,
          'Owner-approved BOL preparation', order.warehouseShipments[0].id]);
      }
      fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      fs.writeFileSync(OUTPUT_PATH, attachment.content);
      result = {
        order: CODE,
        account: ACCOUNT,
        warehouse: WAREHOUSE_CODE,
        status: order.status,
        carrier: CARRIER,
        pallets: PALLETS,
        totalWeight: TOTAL_WEIGHT,
        weightUom: WEIGHT_UOM,
        deliveryDate: DELIVERY_DATE,
        appointmentWindow: '8:00 AM-12:00 PM ET',
        filename: FILENAME,
        outputPath: OUTPUT_PATH,
        pdfSha256: crypto.createHash('sha256').update(attachment.content).digest('hex'),
      };
      await client.query('commit');
    } else {
      result = {
        order: CODE,
        account: ACCOUNT,
        warehouse: WAREHOUSE_CODE,
        status: order.status,
        fullyAllocated: true,
        carrier: CARRIER,
        pallets: PALLETS,
        totalWeight: TOTAL_WEIGHT,
        weightUom: WEIGHT_UOM,
        deliveryDate: DELIVERY_DATE,
        appointmentWindow: '8:00 AM-12:00 PM ET',
        existingBolCount: existing.rowCount,
      };
      await client.query('rollback');
    }
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
