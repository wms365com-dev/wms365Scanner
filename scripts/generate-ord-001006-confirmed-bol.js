const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { getPortalOrderById, buildPortalOrderBillOfLadingPdfAttachment } = require("../server");

// A document-only snapshot of warehouse-confirmed facts. Do not alter reservations.
async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        await client.query("begin read only");
        const order = await getPortalOrderById(client, 1006, "ALCONA TRADING LTD");
        if (!order || order.orderCode !== "ORD-001006" || order.status !== "STAGED") {
            throw new Error("Expected the staged Alcona order ORD-001006.");
        }
        if (order.warehouseShipments.length !== 1 || String(order.warehouseShipments[0].warehouse.id) !== "143") {
            throw new Error("Expected one Edwards warehouse shipment.");
        }
        const pickedPalletDetails = [
            { palletNumber: 1, location: "DJ30AB", weight: 2319, weightUom: "LB" },
            { palletNumber: 2, location: "DJ36AB", weight: 2319, weightUom: "LB" },
            { palletNumber: 3, location: "DJ38AB", weight: 2318, weightUom: "LB" },
            { palletNumber: 4, location: "DJ40AB", weight: 2316, weightUom: "LB" }
        ];
        const totalWeight = Number((9272 * 0.45359237).toFixed(3));
        const snapshot = {
            ...order,
            shippedCarrierName: "Truck 4 Delivery",
            routingTotalWeight: totalWeight,
            routingWeightUom: "KG",
            pickedPalletDetails,
            outboundPallets: { ...order.outboundPallets, totalPalletsOut: 4 },
            routingAppointment: {
                status: "CONFIRMED", appointmentDate: "2026-09-18", windowStart: "11:00 AM ET",
                windowEnd: "", responderName: "Rohan Dandekar"
            },
            orderNotes: "Delivery appointment September 18, 2026 at 11:00 AM Eastern, approved by Rohan Dandekar. Individual tote weights in KG. Inspect totes for damage. EMO reference: S2607S00387647.",
            warehouseShipments: order.warehouseShipments.map((shipment) => ({
                ...shipment, carrier: "Truck 4 Delivery", pallets: { ...shipment.pallets, total: 4 },
                totalWeight, weightUom: "KG", deliveryDate: "2026-09-18"
            }))
        };
        const attachment = buildPortalOrderBillOfLadingPdfAttachment(snapshot);
        if (attachment.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Invalid PDF.");
        const output = path.resolve("output/pdf/WMS365_BOL_ORD-001006.pdf");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, attachment.content);
        const stock = await client.query(
            "select id,account_name,sku,location,quantity from inventory_lines where location=any($1) order by location,id",
            [pickedPalletDetails.map((pallet) => pallet.location)]
        );
        console.log(JSON.stringify({ output, totalWeightKg: totalWeight, stock: stock.rows, databaseChanges: false }, null, 2));
        await client.query("rollback");
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
