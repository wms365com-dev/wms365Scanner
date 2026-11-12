const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  APP_USER_ROLES,
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
  safeDeductInventoryLineQuantity,
  upsertInventoryLine,
} = require('/app/server.js');

const APPLY = process.argv.includes('--apply');
const CODE = 'ORD-001395';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const SKU = 'MS26062403';
const LOT = 'MS26062403';
const DELIVERY_DATE = '2026-10-19';
const DELIVERY_TIME = '13:00';
const LB_TO_KG = 0.45359237;
const PREVIOUS = ['DI26AB', 'DI26AC', 'DI28AA', 'DI28AB'];
const PALLETS_LB = [
  { location: 'DJ44AC', weight: 2319 },
  { location: 'DJ42AC', weight: 2314 },
  { location: 'DJ40AC', weight: 2313 },
  { location: 'DJ38AC', weight: 2322 },
];
const PALLETS = PALLETS_LB.map((p, i) => ({ palletNumber: i + 1, location: p.location,
  weight: Number((p.weight * LB_TO_KG).toFixed(2)), weightUom: 'KG' }));
const TOTAL_KG = Number((PALLETS_LB.reduce((sum, p) => sum + p.weight, 0) * LB_TO_KG).toFixed(2));
const ACTOR = { id: null, email: 'prathab@greywolf3pl.com', full_name: 'Owner-approved mistaken shipment correction', role: APP_USER_ROLES.SUPER_ADMIN };
const CORRECTION_NOTE = 'Owner correction: October 14 shipment posting was entered against ORD-001395 by mistake. Order restored to STAGED; prior shipment evidence retained as GENERAL audit history. Physical picks verified at DJ44AC, DJ42AC, DJ40AC, and DJ38AC. Carrier not assigned; confirm whether Bison will handle this load. Delivery appointment requested for October 19, 2026 at 1:00 PM ET.';
const dateOnly = value => value ? new Date(value).toISOString().slice(0, 10) : '';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (!APPLY) await client.query('set transaction read only');
    const found = await client.query(`select o.*,fl.code warehouse_code from portal_orders o
      join fulfillment_locations fl on fl.id=o.fulfillment_location_id where o.order_code=$1
      ${APPLY ? 'for update of o' : ''}`, [CODE]);
    if (found.rowCount !== 1) throw new Error('Order identity is not unique.');
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || String(row.fulfillment_location_id) !== WAREHOUSE_ID
        || row.warehouse_code !== 'WHS01' || row.status !== 'SHIPPED'
        || dateOnly(row.confirmed_ship_date) !== '2026-10-14'
        || row.po_number !== '529673' || row.shipping_reference !== 'S2607S00390117') {
      throw new Error('Live order identity or mistaken shipment state changed.');
    }
    const order = await getPortalOrderById(client, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== SKU || Number(order.lines[0].quantity) !== 4
        || order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== 'SHIPPED') {
      throw new Error('Order lines or shipment state changed.');
    }
    const oldAllocations = await client.query(`select id,inventory_line_id,location,sku,lot_number,allocated_quantity
      from portal_order_allocations where order_id=$1 order by id ${APPLY ? 'for update' : ''}`, [row.id]);
    if (oldAllocations.rowCount !== 4 || oldAllocations.rows.some((a, i) => a.location !== PREVIOUS[i]
        || a.sku !== SKU || a.lot_number !== LOT || Number(a.allocated_quantity) !== 1
        || a.inventory_line_id != null)) {
      throw new Error(`Prior shipment allocations differ from reviewed evidence: ${JSON.stringify(oldAllocations.rows)}`);
    }
    const shippingTransactions = await client.query(`select id,location,sku,lot_number,quantity_delta,quantity_before,quantity_after
      from inventory_transactions where source_id=$1 and transaction_type='SHIPPING' order by id`, [String(row.id)]);
    if (shippingTransactions.rowCount !== 4 || shippingTransactions.rows.some((t, i) => t.location !== PREVIOUS[i]
        || t.sku !== SKU || t.lot_number !== LOT || Number(t.quantity_delta) !== -1
        || Number(t.quantity_before) !== 1 || Number(t.quantity_after) !== 0)) {
      throw new Error('Mistaken shipment inventory deductions differ from reviewed evidence.');
    }
    const targetBins = await client.query(`select code,is_pickable,fulfillment_location_id from bin_locations
      where upper(code)=any($1::text[])`, [PALLETS.map(p => p.location)]);
    if (targetBins.rowCount !== 4 || targetBins.rows.some(b => !b.is_pickable
        || (b.fulfillment_location_id != null && String(b.fulfillment_location_id) !== WAREHOUSE_ID))) {
      throw new Error('One or more target bins are missing, non-pickable, or assigned to another warehouse.');
    }
    const targets = await client.query(`select id,location,sku,upc,lot_number,expiration_date,quantity,tracking_level
      from inventory_lines where account_name=$1 and sku=$2 and upper(location)=any($3::text[])
      order by array_position($3::text[],upper(location)),id ${APPLY ? 'for update' : ''}`,
    [ACCOUNT, SKU, PALLETS.map(p => p.location)]);
    if (targets.rowCount !== 0) {
      throw new Error(`Target pallet inventory does not match the warehouse report: ${JSON.stringify(targets.rows)}`);
    }
    if (APPLY) {
      const restoredSources = [];
      for (const t of shippingTransactions.rows) {
        const restored = await upsertInventoryLine(client, { accountName: ACCOUNT, location: t.location, sku: SKU,
          upc: '', lotNumber: LOT, expirationDate: '', trackingLevel: 'PALLET', quantity: 1 }, {
          transactionType: 'ADJUSTMENT', sourceType: 'PORTAL_ORDER_SHIPMENT_CORRECTION', sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: 'web_admin',
          idempotencyKey: `${CODE}-mistaken-ship-restore-${t.location}`,
        });
        restoredSources.push(restored);
      }
      for (let i = 0; i < PALLETS.length; i += 1) {
        const target = PALLETS[i];
        await upsertInventoryLine(client, { accountName: ACCOUNT, location: target.location, sku: SKU,
          upc: '', lotNumber: LOT, expirationDate: '', trackingLevel: 'PALLET', quantity: 1 }, {
          transactionType: 'MOVE_LOCATION', sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION', sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: 'web_admin',
          idempotencyKey: `${CODE}-${PREVIOUS[i]}-to-${target.location}`,
        });
        await safeDeductInventoryLineQuantity(client, restoredSources[i].id, 1, {
          actionLabel: `move restored pallet ${PREVIOUS[i]} to ${target.location}`,
          transactionType: 'MOVE_LOCATION', sourceType: 'PORTAL_ORDER_PALLET_LOCATION_CORRECTION', sourceId: row.id,
          fulfillmentLocationId: row.fulfillment_location_id, appUser: ACTOR, source: 'web_admin',
          idempotencyKey: `${CODE}-${PREVIOUS[i]}-to-${target.location}`,
        });
      }
      await client.query('delete from portal_order_allocations where order_id=$1', [row.id]);
      const lineId = order.lines[0].id;
      const finalTargets = (await client.query(`select id,location,sku,upc,lot_number,expiration_date,quantity,tracking_level
        from inventory_lines where account_name=$1 and sku=$2 and upper(location)=any($3::text[])
        order by array_position($3::text[],upper(location)),id for update`,
      [ACCOUNT, SKU, PALLETS.map(p => p.location)])).rows;
      if (finalTargets.length !== 4 || finalTargets.some((t, i) => t.location !== PALLETS[i].location
          || t.lot_number !== LOT || Number(t.quantity) !== 1 || t.tracking_level !== 'PALLET')) {
        throw new Error('Location correction did not produce the four target pallet lines.');
      }
      for (const t of finalTargets) {
        await client.query(`insert into portal_order_allocations
          (order_id,order_line_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity)
          values($1,$2,$3,$4,$5,$6,$7,'PALLET',1)`,
        [row.id, lineId, t.id, SKU, t.location, LOT, t.expiration_date || '']);
      }
      const notes = String(row.order_notes || '').includes(CORRECTION_NOTE) ? row.order_notes : `${row.order_notes || ''}\n${CORRECTION_NOTE}`.trim();
      await client.query(`update portal_orders set status='STAGED',shipped_at=null,confirmed_ship_date=null,
        shipped_carrier_name='',shipped_tracking_reference='',shipped_confirmation_note='',
        shipment_email_status='',shipment_email_scheduled_at=null,shipment_email_sent_at=null,
        shipment_email_last_error='',shipment_email_attempts=0,shipment_email_is_update=false,
        picked_pallet_details=$2::jsonb,routing_total_weight=$3,routing_weight_uom='KG',
        routing_requested_delivery_date=$4::date,requested_ship_date=$4::date,
        outbound_total_pallets=4,outbound_existing_pallets=4,outbound_new_pallets=0,outbound_mixed_pallets=0,
        order_notes=$5,updated_at=now() where id=$1`,
      [row.id, JSON.stringify(PALLETS), TOTAL_KG, DELIVERY_DATE, notes]);
      await client.query(`update warehouse_shipments set status='STAGED',carrier_name='',tracking_reference='',bol_reference='',
        total_pallets=4,existing_pallets=4,new_pallets=0,mixed_pallets=0,total_weight=$2,weight_uom='KG',
        delivery_date=$3::date,shipped_at=null,updated_at=now() where order_id=$1`, [row.id, TOTAL_KG, DELIVERY_DATE]);
      await client.query(`update portal_order_documents set document_category='GENERAL'
        where order_id=$1 and document_category in ('SHIPMENT_BOL','SHIPMENT_PACKING_SLIP','SHIPMENT_LOAD_PHOTO')
          and created_at::date='2026-10-14'::date`, [row.id]);
      await client.query(`update order_routing_requests set status='PENDING',appointment_date=$2::date,
        window_start=$3::time,window_end=null,responder_name='',responder_note='Owner-requested 1:00 PM ET appointment; recipient confirmation pending.',
        responded_at=null,updated_at=now() where order_id=$1`, [row.id, DELIVERY_DATE, DELIVERY_TIME]);
      await client.query('commit');
    } else await client.query('rollback');
    const verify = await getPortalOrderById(client, row.id, ACCOUNT);
    const allocations = await client.query(`select a.location,a.sku,a.lot_number,a.allocated_quantity,i.quantity,i.tracking_level
      from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id where a.order_id=$1 order by a.id`, [row.id]);
    if (APPLY && (verify.status !== 'STAGED' || verify.shippedAt || allocations.rowCount !== 4
        || allocations.rows.some((a, i) => a.location !== PALLETS[i].location || a.sku !== SKU
          || a.lot_number !== LOT || Number(a.allocated_quantity) !== 1 || Number(a.quantity) < 1))) {
      throw new Error('Post-correction verification failed.');
    }
    const bolOrder = { ...verify, status: 'STAGED', shippedAt: null, confirmedShipDate: '',
      shippedCarrierName: '', shippedTrackingReference: '', pickedPalletDetails: PALLETS, routingTotalWeight: TOTAL_KG,
      routingWeightUom: 'KG', routingAppointment: { status: 'PENDING', appointmentDate: DELIVERY_DATE, windowStart: DELIVERY_TIME },
      orderNotes: `${CORRECTION_NOTE} PRE-SHIPMENT / UNSIGNED.`, warehouseShipments: verify.warehouseShipments.map(s => ({
        ...s, status: 'STAGED', shippedAt: null, carrier: 'TO BE CONFIRMED', totalPallets: 4, existingPallets: 4, newPallets: 0,
        mixedPallets: 0, totalWeight: TOTAL_KG, weightUom: 'KG', deliveryDate: DELIVERY_DATE,
        trackingReference: verify.shippingReference,
      })) };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(', ')}`);
    const attachment = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (attachment.content.subarray(0, 4).toString() !== '%PDF') throw new Error('Invalid BOL PDF.');
    console.log(JSON.stringify({ order: CODE, applied: APPLY, status: verify.status,
      carrier: '', carrierQuestion: 'Confirm whether Bison Transport will handle this load.',
      deliveryDate: DELIVERY_DATE, deliveryTime: '1:00 PM ET', pallets: PALLETS,
      totalWeightKg: TOTAL_KG, pdfSha256: crypto.createHash('sha256').update(attachment.content).digest('hex'),
      pdfBase64: attachment.content.toString('base64') }));
  } finally { client.release(); await pool.end(); }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
