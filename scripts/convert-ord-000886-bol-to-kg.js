const {
    buildPortalOrderBillOfLadingPdfAttachment,
    getPortalOrderById,
    withTransaction
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ORDER_CODE = "ORD-000886";
const ACCOUNT = "ALCONA TRADING LTD";
const CONFIRMATION = "APPROVED_ORD_000886_BOL_KG";
const LB_TO_KG = 0.45359237;

function toKg(value) {
    return Number((Number(value) * LB_TO_KG).toFixed(3));
}

async function main() {
    if (APPLY && process.env.CONFIRM_ORD_000886_BOL_KG !== CONFIRMATION) {
        throw new Error(`Set CONFIRM_ORD_000886_BOL_KG=${CONFIRMATION} before --apply.`);
    }

    const result = await withTransaction(async (client) => {
        const orderResult = await client.query(
            `select id,order_code,account_name,status,routing_total_weight,routing_weight_uom,
                    picked_pallet_details,fulfillment_location_id
             from portal_orders where order_code=$1 limit 1${APPLY ? " for update" : ""}`,
            [ORDER_CODE]
        );
        if (orderResult.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found.`);
        const order = orderResult.rows[0];
        if (order.account_name !== ACCOUNT) throw new Error(`Order belongs to ${order.account_name}, not ${ACCOUNT}.`);
        if (order.status !== "STAGED") throw new Error(`Order is ${order.status}, not STAGED.`);

        const shipmentResult = await client.query(
            `select id,shipment_code,status,total_weight,weight_uom,fulfillment_location_id
             from warehouse_shipments where order_id=$1 order by id${APPLY ? " for update" : ""}`,
            [order.id]
        );
        if (shipmentResult.rowCount !== 1) throw new Error(`${ORDER_CODE} must have exactly one warehouse shipment.`);
        const shipment = shipmentResult.rows[0];
        if (String(shipment.fulfillment_location_id) !== String(order.fulfillment_location_id)) {
            throw new Error("The warehouse shipment does not match the order warehouse.");
        }

        const pallets = Array.isArray(order.picked_pallet_details) ? order.picked_pallet_details : [];
        if (pallets.length !== 4 || pallets.some((pallet) => String(pallet.weightUom || "").toUpperCase() !== "LB")) {
            throw new Error("Expected four original pallet weights recorded in LB.");
        }
        const totalLb = pallets.reduce((sum, pallet) => sum + Number(pallet.weight || 0), 0);
        if (totalLb !== 9265) throw new Error(`Expected 9,265 LB from pallet details, found ${totalLb}.`);
        const totalKg = toKg(totalLb);

        if (!APPLY) {
            return {
                mode: "audit",
                orderCode: order.order_code,
                orderStatus: order.status,
                currentOrderWeight: `${order.routing_total_weight} ${order.routing_weight_uom}`,
                currentShipmentWeight: `${shipment.total_weight} ${shipment.weight_uom}`,
                convertedPallets: pallets.map((pallet) => ({
                    location: pallet.location,
                    weightKg: Number(toKg(pallet.weight).toFixed(1))
                })),
                convertedTotalKg: Number(totalKg.toFixed(1))
            };
        }

        await client.query(
            `update portal_orders
             set routing_total_weight=$2,routing_weight_uom='KG',updated_at=now()
             where id=$1`,
            [order.id, totalKg]
        );
        await client.query(
            `update warehouse_shipments
             set total_weight=$2,weight_uom='KG',updated_at=now()
             where id=$1`,
            [shipment.id, totalKg]
        );
        await client.query(
            `insert into activity_log (type,title,details,created_at)
             values ('order',$1,$2,now())`,
            [
                `Changed BOL weight display to KG for ${ORDER_CODE}`,
                `${ACCOUNT} | ${totalLb} LB converted to ${totalKg} KG | WMS365 Support`
            ]
        );

        const updated = await getPortalOrderById(client, order.id, ACCOUNT);
        const pdf = buildPortalOrderBillOfLadingPdfAttachment(updated);
        if (!pdf?.content || pdf.content.subarray(0, 4).toString() !== "%PDF") {
            throw new Error("The updated BOL PDF could not be generated.");
        }
        return {
            mode: "applied",
            orderCode: updated.orderCode,
            status: updated.status,
            totalWeight: updated.routingTotalWeight,
            weightUom: updated.routingWeightUom,
            bolPdfVerified: true,
            pdfBytes: pdf.content.length
        };
    });

    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
