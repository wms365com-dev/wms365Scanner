const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
    buildPortalOrderBillOfLadingPdfAttachment,
    getPortalOrderBillOfLadingReadiness,
    getPortalOrderById
} = require("../server");

const ORDER_ID = 1007;
const ACCOUNT = "ALCONA TRADING LTD";
const DELIVERY_DATE = "2026-09-23";
const CARRIER = "Truck 4 Delivery";
const BATCH = "MS26062403";
const PALLETS = [
    { palletNumber: 1, location: "DJ14AA", weight: 2313, weightUom: "LB" },
    { palletNumber: 2, location: "DJ16AA", weight: 2312, weightUom: "LB" },
    { palletNumber: 3, location: "DJ16AB", weight: 2310, weightUom: "LB" },
    { palletNumber: 4, location: "DJ02AA", weight: 2308, weightUom: "LB" }
];

async function build() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection unavailable.");
    const pool = new Pool({ connectionString, ssl: false, max: 1 });
    const client = await pool.connect();
    try {
        await client.query("begin read only");
        const order = await getPortalOrderById(client, ORDER_ID, ACCOUNT);
        if (!order || order.orderCode !== "ORD-001007" || order.status !== "STAGED"
            || String(order.fulfillmentLocationId) !== "143" || order.lines.length !== 1
            || order.lines[0].sku !== "MS26053103" || Number(order.lines[0].quantity) !== 4
            || order.warehouseShipments.length !== 1
            || order.warehouseShipments[0].status !== "STAGED") {
            throw new Error("ORD-001007 no longer matches the reviewed staged Alcona order.");
        }
        const totalLb = PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0);
        if (Number(order.routingTotalWeight) !== totalLb || Number(order.outboundPallets.totalPalletsOut) !== 4) {
            throw new Error("The recorded pallet count or total weight changed.");
        }
        if (String(order.routingRequestedDeliveryDate).slice(0, 10) !== DELIVERY_DATE) {
            throw new Error("The requested delivery date no longer matches the stated appointment date.");
        }
        const totalKg = Number((totalLb * 0.45359237).toFixed(3));
        const snapshot = {
            ...order,
            lines: order.lines.map(line => ({ ...line, sku: BATCH, description: `Batch ${BATCH}` })),
            shippedCarrierName: CARRIER,
            routingTotalWeight: totalKg,
            routingWeightUom: "KG",
            pickedPalletDetails: PALLETS,
            outboundPallets: { ...order.outboundPallets, totalPalletsOut: 4 },
            routingAppointment: { status: "CONFIRMED", appointmentDate: DELIVERY_DATE,
                windowStart: "11:00 AM ET", windowEnd: "", responderName: "" },
            orderNotes: "Batch MS26062403. Appointment Sep 23, 2026 at 11:00 AM ET. EMO S2607S00387647. Inspect totes for damage.",
            warehouseShipments: order.warehouseShipments.map(shipment => ({
                ...shipment, carrier: CARRIER, pallets: { ...shipment.pallets, total: 4 },
                totalWeight: totalKg, weightUom: "KG", deliveryDate: DELIVERY_DATE
            }))
        };
        const readiness = getPortalOrderBillOfLadingReadiness(snapshot);
        if (!readiness.ready) throw new Error(`BOL not ready: ${readiness.missingFields.join(", ")}`);
        const attachment = buildPortalOrderBillOfLadingPdfAttachment(snapshot);
        if (attachment.content.subarray(0, 4).toString() !== "%PDF") throw new Error("BOL renderer did not return a PDF.");
        await client.query("rollback");
        return { filename: "WMS365_BOL_ORD-001007_2026-09-23.pdf",
            content: attachment.content, sha256: crypto.createHash("sha256").update(attachment.content).digest("hex"),
            totalLb, totalKg, account: ACCOUNT, order: order.orderCode, carrier: CARRIER,
            deliveryDate: DELIVERY_DATE, palletCount: PALLETS.length, batch: BATCH };
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

async function main() {
    const result = await build();
    console.log(JSON.stringify({ ...result, content: result.content.toString("base64") }));
}

module.exports = { build, main };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
