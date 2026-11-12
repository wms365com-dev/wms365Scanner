const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
    buildPortalOrderBillOfLadingPdfAttachment,
    getPortalOrderBillOfLadingReadiness,
    getPortalOrderById
} = require("../server");

const ORDER_ID = 1204;
const ORDER_CODE = "ORD-001204";
const ACCOUNT = "ALCONA TRADING LTD";
const WAREHOUSE_ID = 143;
const APPOINTMENT_DATE = "2026-09-28";
const PALLETS = [
    { palletNumber: 1, location: "DI04AA", weight: 2310, weightUom: "LB" },
    { palletNumber: 2, location: "DI06AA", weight: 2311, weightUom: "LB" },
    { palletNumber: 3, location: "DI08AA", weight: 2312, weightUom: "LB" },
    { palletNumber: 4, location: "DI10AA", weight: 2313, weightUom: "LB" }
];
const TOTAL_LB = PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0);
const TOTAL_KG = Number((TOTAL_LB * 0.45359237).toFixed(3));
const NOTE = "Appointment confirmed for Mon 2026-09-28 at 1:00 PM Eastern. Warehouse-reported pallet bins: DI04AA 2310 lb; DI06AA 2311 lb; DI08AA 2312 lb; DI10AA 2313 lb. Inventory allocations require separate reconciliation; no stock was moved.";

function assertOrder(order) {
    if (!order || order.orderCode !== ORDER_CODE || order.accountName !== ACCOUNT
        || String(order.fulfillmentLocationId) !== String(WAREHOUSE_ID)
        || order.status !== "STAGED" || order.shippedAt
        || order.lines.length !== 1 || order.lines[0].sku !== "MS26060402G"
        || Number(order.lines[0].quantity) !== 4
        || order.warehouseShipments.length !== 1
        || order.warehouseShipments[0].status !== "STAGED"
        || Number(order.outboundPallets.totalPalletsOut) !== 4) {
        throw new Error("ORD-001204 no longer matches the reviewed staged Alcona order.");
    }
}

async function main() {
    const carrier = String(process.env.ORD_001204_CONFIRMED_CARRIER || "").trim();
    if (carrier && !/^[\w .&-]{2,80}$/.test(carrier)) throw new Error("The confirmed carrier name is invalid.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection unavailable.");
    const pool = new Pool({ connectionString, ssl: false, max: 1 });
    const client = await pool.connect();
    let updated;
    try {
        await client.query("begin");
        const locked = await client.query("select id, status, account_name, fulfillment_location_id, shipped_at, order_notes, shipped_carrier_name, routing_total_weight, routing_requested_delivery_date::text as routing_requested_delivery_date, picked_pallet_details from portal_orders where id=$1 for update", [ORDER_ID]);
        const row = locked.rows[0];
        if (locked.rowCount !== 1 || row.status !== "STAGED" || row.account_name !== ACCOUNT
            || String(row.fulfillment_location_id) !== String(WAREHOUSE_ID) || row.shipped_at) {
            throw new Error("The live order identity or status changed.");
        }
        const current = await getPortalOrderById(client, ORDER_ID, ACCOUNT);
        assertOrder(current);
        if (carrier && row.shipped_carrier_name && row.shipped_carrier_name !== carrier) {
            throw new Error("The order already has a different carrier. Review before overwriting.");
        }
        const shipment = current.warehouseShipments[0];
        if (carrier && shipment.carrier && shipment.carrier !== carrier) {
            throw new Error("The warehouse shipment already has a different carrier.");
        }
        const oldPallets = current.pickedPalletDetails || [];
        const reviewedOld = ["DH42AA", "DH42AB", "DI02AA", "DI02AC"];
        const locations = oldPallets.map(pallet => pallet.location);
        if (JSON.stringify(locations) !== JSON.stringify(reviewedOld)
            && JSON.stringify(locations) !== JSON.stringify(PALLETS.map(pallet => pallet.location))) {
            throw new Error("Pallet location details changed since review.");
        }
        if (row.routing_total_weight != null && Number(row.routing_total_weight) !== TOTAL_LB) {
            throw new Error("The recorded freight weight conflicts with the warehouse report.");
        }
        if (row.routing_requested_delivery_date && String(row.routing_requested_delivery_date).slice(0, 10) !== APPOINTMENT_DATE) {
            throw new Error("The recorded delivery date conflicts with the confirmed appointment.");
        }
        const notes = String(row.order_notes || "").includes(NOTE) ? row.order_notes : `${row.order_notes || ""}\n${NOTE}`.trim();
        await client.query(`update portal_orders set picked_pallet_details=$2::jsonb,
            routing_total_weight=$3, routing_weight_uom='LB', routing_requested_delivery_date=$4::date,
            shipped_carrier_name=case when $5<>'' then $5 else shipped_carrier_name end,
            order_notes=$6, updated_at=now() where id=$1`,
        [ORDER_ID, JSON.stringify(PALLETS), TOTAL_LB, APPOINTMENT_DATE, carrier, notes]);
        const shipmentUpdate = await client.query(`update warehouse_shipments set
            carrier_name=case when $2<>'' then $2 else carrier_name end,
            total_weight=$3, weight_uom='LB', delivery_date=$4::date, updated_at=now()
            where order_id=$1 and account_name=$5 and fulfillment_location_id=$6 and status='STAGED'
            returning id`, [ORDER_ID, carrier, TOTAL_LB, APPOINTMENT_DATE, ACCOUNT, WAREHOUSE_ID]);
        if (shipmentUpdate.rowCount !== 1) throw new Error("The staged warehouse shipment changed during the update.");
        updated = await getPortalOrderById(client, ORDER_ID, ACCOUNT);
        assertOrder(updated);
        if ((carrier && updated.shippedCarrierName !== carrier) || Number(updated.routingTotalWeight) !== TOTAL_LB
            || JSON.stringify(updated.pickedPalletDetails.map(pallet => pallet.location)) !== JSON.stringify(PALLETS.map(pallet => pallet.location))) {
            throw new Error("The updated order failed readback verification.");
        }
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }

    if (!carrier) {
        console.log(JSON.stringify({ order: ORDER_CODE, status: updated.status,
            appointment: `${APPOINTMENT_DATE} 1:00 PM ET`, palletCount: 4, totalLb: TOTAL_LB,
            totalKg: TOTAL_KG, inventoryMoved: false, bolPending: "Confirmed carrier required" }));
        return;
    }

    const bolOrder = {
        ...updated,
        routingTotalWeight: TOTAL_KG,
        routingWeightUom: "KG",
        routingAppointment: { status: "CONFIRMED", appointmentDate: APPOINTMENT_DATE,
            windowStart: "1:00 PM ET", windowEnd: "", responderName: "" },
        orderNotes: "Appointment confirmed Mon Sep 28, 2026 at 1:00 PM Eastern. EMO ref S2607S00390117. Inspect totes for damage.",
        warehouseShipments: updated.warehouseShipments.map(shipment => ({
            ...shipment, carrier, totalWeight: TOTAL_KG, weightUom: "KG", deliveryDate: APPOINTMENT_DATE,
            trackingReference: "S2607S00390117"
        }))
    };
    const readiness = getPortalOrderBillOfLadingReadiness(bolOrder);
    if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
    const attachment = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    if (attachment.content.subarray(0, 4).toString() !== "%PDF") throw new Error("BOL renderer did not return a PDF.");
    console.log(JSON.stringify({ order: ORDER_CODE, status: updated.status, carrier,
        appointment: `${APPOINTMENT_DATE} 1:00 PM ET`, palletCount: 4, totalLb: TOTAL_LB,
        totalKg: TOTAL_KG, filename: "WMS365_BOL_ORD-001204_2026-09-28.pdf",
        sha256: crypto.createHash("sha256").update(attachment.content).digest("hex"),
        inventoryMoved: false, pdfBase64: attachment.content.toString("base64") }));
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
