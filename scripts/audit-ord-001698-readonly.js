"use strict";

const { Client } = require("pg");
const { getPortalOrderById } = require("../server");

const CODE = "ORD-001698";
const ACCOUNT = "ALCONA TRADING LTD";
const PO = "529673";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin read only");
    const result = await client.query(`select o.id,o.order_code,o.account_name,o.po_number,o.status,o.shipped_at,
      o.fulfillment_location_id,fl.code warehouse_code,o.shipped_carrier_name,o.routing_requested_delivery_date::text,
      o.routing_total_weight,o.routing_weight_uom,o.picked_pallet_details
      from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1`, [CODE]);
    if (result.rowCount !== 1) throw new Error("Order identity is not unique.");
    const row = result.rows[0];
    if (row.account_name !== ACCOUNT || row.po_number !== PO) throw new Error("Order tenant or PO mismatch.");
    const order = await getPortalOrderById(client, row.id, ACCOUNT);
    const allocations = await client.query(`select a.sku,a.location,a.lot_number,a.tracking_level,a.allocated_quantity,
      i.quantity inventory_quantity from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
      where a.order_id=$1 order by a.id`, [row.id]);
    const routing = await client.query(`select id,status,appointment_date::text,window_start::text,window_end::text
      from order_routing_requests where order_id=$1 order by id desc`, [row.id]);
    const documents = await client.query(`select id,file_name,document_category,file_size,created_at
      from portal_order_documents where order_id=$1 and document_category='SHIPMENT_BOL' order by id`, [row.id]);
    await client.query("rollback");
    console.log(JSON.stringify({
      order: CODE,
      account: row.account_name,
      po: row.po_number,
      status: row.status,
      shipped: !!row.shipped_at,
      warehouseId: row.fulfillment_location_id,
      warehouseCode: row.warehouse_code,
      carrier: row.shipped_carrier_name || "",
      deliveryDate: row.routing_requested_delivery_date || "",
      routingWeight: row.routing_total_weight,
      routingWeightUom: row.routing_weight_uom || "",
      pickedPalletDetails: row.picked_pallet_details || [],
      lines: order.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, allocatedQuantity: line.allocatedQuantity })),
      shipments: order.warehouseShipments.map((shipment) => ({ id: shipment.id, status: shipment.status, carrier: shipment.carrier,
        totalPallets: shipment.totalPallets, totalWeight: shipment.totalWeight, weightUom: shipment.weightUom,
        deliveryDate: shipment.deliveryDate })),
      allocations: allocations.rows,
      routing: routing.rows,
      bolDocuments: documents.rows
    }));
  } finally {
    await client.end();
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
