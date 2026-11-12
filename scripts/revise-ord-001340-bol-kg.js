const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  buildPortalOrderBillOfLadingPdfAttachment,
  getPortalOrderBillOfLadingReadiness,
  getPortalOrderById,
} = require('../server');

const ORDER_CODE = 'ORD-001340';
const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = '143';
const WMS_SKU = 'MS26060402G';
const DOCUMENT_ITEM = 'MS26062403';
const BINS = ['DI34AA', 'DI14AB', 'DI16AB', 'DI28AA'];
const WEIGHTS_LB = [2311, 2312, 2313, 2310];
const LB_TO_KG = 0.45359237;
const TOTAL_KG = Number((WEIGHTS_LB.reduce((a, b) => a + b, 0) * LB_TO_KG).toFixed(2));

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const found = await client.query('SELECT id FROM portal_orders WHERE order_code=$1 AND account_name=$2', [ORDER_CODE, ACCOUNT]);
    if (found.rowCount !== 1) throw new Error('Order identity not unique.');
    const order = await getPortalOrderById(client, found.rows[0].id, ACCOUNT);
    if (order.orderCode !== ORDER_CODE || order.accountName !== ACCOUNT ||
        String(order.fulfillmentLocationId) !== WAREHOUSE_ID || order.status !== 'STAGED' || order.shippedAt ||
        order.lines.length !== 1 || order.lines[0].sku !== WMS_SKU || Number(order.lines[0].quantity) !== 4 ||
        order.warehouseShipments.length !== 1 || order.warehouseShipments[0].status !== 'STAGED' ||
        order.warehouseShipments[0].carrier !== 'Truck 4 Delivery' ||
        Number(order.warehouseShipments[0].totalWeight) !== 9246 ||
        order.poNumber !== '529672' || order.shippingReference !== 'S2607S00390117' ||
        order.shipToName !== 'NUTEM CUSTOM MANUFACTURING' ||
        (order.pickedPalletDetails || []).length !== 4 ||
        order.pickedPalletDetails.some((p, i) => p.location !== BINS[i] || Number(p.weight) !== WEIGHTS_LB[i]) ||
        !order.orderNotes.includes(DOCUMENT_ITEM)) {
      throw new Error('Live staged order, physical bins, or warehouse-confirmed item code changed.');
    }

    const bolOrder = {
      ...order,
      lines: order.lines.map(line => ({ ...line, sku: DOCUMENT_ITEM, description: DOCUMENT_ITEM })),
      routingTotalWeight: TOTAL_KG,
      routingWeightUom: 'KG',
      routingAppointment: { status: 'CONFIRMED', appointmentDate: '2026-10-06', windowStart: '11:00 AM ET' },
      orderNotes: `REVISED BOL. Item / batch ${DOCUMENT_ITEM} on all four pallets. Delivery Oct 6 at 11:00 AM ET per owner; receiver confirmation not independently verified. PRE-SHIPMENT / UNSIGNED.`,
      warehouseShipments: order.warehouseShipments.map(shipment => ({
        ...shipment,
        totalWeight: TOTAL_KG,
        weightUom: 'KG',
        deliveryDate: '2026-10-06',
        trackingReference: order.shippingReference,
      })),
    };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(', ')}`);
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder).content;
    if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('System BOL renderer returned invalid content.');
    const result = {
      order: ORDER_CODE,
      status: order.status,
      documentItem: DOCUMENT_ITEM,
      wmsSkuUnchanged: WMS_SKU,
      weightsKg: WEIGHTS_LB.map(weight => Number((weight * LB_TO_KG).toFixed(2))),
      totalKg: TOTAL_KG,
      pdfSha256: crypto.createHash('sha256').update(pdf).digest('hex'),
      pdfBase64: pdf.toString('base64'),
    };
    await client.query('ROLLBACK');
    console.log(JSON.stringify(result));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
