const {
    APP_USER_ROLES,
    getPortalOrderById,
    reallocatePortalOrderToActualPalletLocations,
    safeDeductInventoryLineQuantity,
    updateWarehouseShipmentDetail,
    upsertInventoryLine,
    withTransaction
} = require("../server");

const apply = process.argv.includes("--apply");
const orderCode = "ORD-001338";
const account = "ALCONA TRADING LTD";
const sku = "MS26060402G";
const batchReference = "MS26062403";
const warehouseId = "143";
const carrier = "Truck 4 Delivery";
const pallets = [
    { palletNumber: 1, from: "DH42AC", location: "DI14AA", weight: 2311, weightUom: "LB" },
    { palletNumber: 2, from: "DH44AA", location: "DI12AA", weight: 2311, weightUom: "LB" },
    { palletNumber: 3, from: "DH44AB", location: "DI16AA", weight: 2311, weightUom: "LB" },
    { palletNumber: 4, from: "DH44AC", location: "DI18AA", weight: 2312, weightUom: "LB" }
];
const totalWeight = pallets.reduce((sum, pallet) => sum + pallet.weight, 0);
const note = `Physical batch reference ${batchReference} confirmed by owner; WMS item SKU remains ${sku}. Actual picked pallets: ${pallets.map((pallet) => `${pallet.location} ${pallet.weight} lb`).join("; ")}.`;
const actor = {
    id: null,
    email: "prathab@greywolf3pl.com",
    full_name: "Owner-confirmed pallet location correction",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function main() {
    if (apply && process.env.CONFIRM_ORD_001338_PICK !== "OWNER_CONFIRMED_BATCH_AND_CARRIER") {
        throw new Error("Owner confirmation required before correcting physical pallet locations");
    }
    const result = await withTransaction(async (client) => {
        const rows = await client.query(
            `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                    o.shipped_at,o.picked_pallet_details,o.routing_total_weight,
                    o.shipped_carrier_name,o.outbound_total_pallets,o.order_notes,
                    fl.code as warehouse
             from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1 ${apply ? "for update of o" : ""}`,
            [orderCode]
        );
        if (rows.rowCount !== 1) throw new Error("Order identity is not unique");
        const row = rows.rows[0];
        if (row.account_name !== account || row.warehouse !== "WHS01" ||
            String(row.fulfillment_location_id) !== warehouseId || row.status !== "STAGED" ||
            row.shipped_at || Number(row.outbound_total_pallets) !== 4) {
            throw new Error("Order ownership, warehouse, stage, or pallet count changed");
        }
        const order = await getPortalOrderById(client, row.id, account);
        if (!order || order.lines.length !== 1 || order.lines[0].sku !== sku ||
            Number(order.lines[0].quantity) !== 4 || order.warehouseShipments.length !== 1 ||
            order.warehouseShipments[0].status !== "STAGED") {
            throw new Error("Order lines or shipment changed");
        }
        const allocations = await client.query(
            `select a.id,a.inventory_line_id,a.location,a.sku,a.allocated_quantity,
                    i.account_name,i.quantity,i.upc,i.lot_number,i.expiration_date,i.tracking_level
             from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
             where a.order_id=$1 order by a.id ${apply ? "for update of a,i" : ""}`,
            [row.id]
        );
        if (allocations.rowCount !== pallets.length) throw new Error("Expected four pallet allocations");
        const sourceMode = pallets.every((pallet, index) =>
            allocations.rows[index].location === pallet.from &&
            allocations.rows[index].sku === sku && allocations.rows[index].account_name === account &&
            Number(allocations.rows[index].allocated_quantity) === 1 && Number(allocations.rows[index].quantity) === 1);
        const targetMode = pallets.every((pallet, index) =>
            allocations.rows[index].location === pallet.location &&
            allocations.rows[index].sku === sku && allocations.rows[index].account_name === account &&
            Number(allocations.rows[index].allocated_quantity) === 1 && Number(allocations.rows[index].quantity) === 1);
        if (!sourceMode && !targetMode) throw new Error("Allocations do not match the reviewed original or corrected pallet bins");
        const currentPallets = (row.picked_pallet_details || []).map((pallet) => pallet.location);
        const expectedPallets = pallets.map((pallet) => targetMode ? pallet.location : pallet.from);
        if (JSON.stringify(currentPallets) !== JSON.stringify(expectedPallets)) {
            throw new Error("Saved pallet details conflict with allocations");
        }
        if (row.shipped_carrier_name && row.shipped_carrier_name !== carrier) {
            throw new Error("Existing carrier conflicts with owner confirmation");
        }
        if (row.routing_total_weight != null && Number(row.routing_total_weight) !== totalWeight) {
            throw new Error("Existing freight weight conflicts with reported pallet weights");
        }
        const shipment = order.warehouseShipments[0];
        if (shipment.carrier && shipment.carrier !== carrier) throw new Error("Shipment carrier conflicts");
        const occupied = await client.query(
            `select location,account_name,sku,quantity from inventory_lines
             where upper(location)=any($1::text[]) order by location`,
            [pallets.map((pallet) => pallet.location)]
        );
        if (sourceMode && occupied.rowCount !== 0) throw new Error("A target bin is no longer empty");
        if (!apply) return { order: orderCode, status: row.status, sourceMode, targetMode,
            currentPallets, newPallets: pallets, totalWeight, occupied: occupied.rows };
        if (sourceMode) {
            for (let index = 0; index < pallets.length; index += 1) {
                const pallet = pallets[index];
                const source = allocations.rows[index];
                await upsertInventoryLine(client, {
                    accountName: account, location: pallet.location, sku,
                    upc: source.upc || "", lotNumber: source.lot_number || "",
                    expirationDate: source.expiration_date || "",
                    trackingLevel: source.tracking_level, quantity: 1
                }, {
                    transactionType: "MOVE_LOCATION",
                    sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION",
                    sourceId: row.id,
                    fulfillmentLocationId: row.fulfillment_location_id,
                    appUser: actor,
                    source: "web_admin",
                    idempotencyKey: `${orderCode}-${pallet.from}-to-${pallet.location}`
                });
            }
            await reallocatePortalOrderToActualPalletLocations(client, order, pallets, actor);
            for (let index = 0; index < pallets.length; index += 1) {
                const pallet = pallets[index];
                await safeDeductInventoryLineQuantity(client, allocations.rows[index].inventory_line_id, 1, {
                    actionLabel: `record physical pallet move ${pallet.from} to ${pallet.location}`,
                    transactionType: "MOVE_LOCATION",
                    sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION",
                    sourceId: row.id,
                    fulfillmentLocationId: row.fulfillment_location_id,
                    appUser: actor,
                    source: "web_admin",
                    idempotencyKey: `${orderCode}-${pallet.from}-to-${pallet.location}`
                });
            }
        }
        await client.query(
            `update portal_orders set picked_pallet_details=$2::jsonb,
                routing_total_weight=$3,routing_weight_uom='LB',
                shipped_carrier_name=$4,
                order_notes=$5,updated_at=now() where id=$1`,
            [row.id, JSON.stringify(pallets.map(({ palletNumber, location, weight, weightUom }) =>
                ({ palletNumber, location, weight, weightUom }))), totalWeight, carrier,
            String(row.order_notes || "").includes(note) ? row.order_notes : `${row.order_notes || ""}\n${note}`.trim()]
        );
        await updateWarehouseShipmentDetail(client, shipment.id, {
            status: "STAGED", carrier, totalPallets: 4, totalWeight, weightUom: "LB"
        }, { accountName: account, actor: actor.full_name });
        const updated = await getPortalOrderById(client, row.id, account);
        if (updated.status !== "STAGED" || updated.shippedAt ||
            updated.pickedPalletDetails.map((pallet) => pallet.location).join("|") !==
                pallets.map((pallet) => pallet.location).join("|") ||
            Number(updated.routingTotalWeight) !== totalWeight) {
            throw new Error("Order readback did not match the corrected pallet picks");
        }
        return { order: orderCode, status: updated.status, corrected: sourceMode,
            pallets: updated.pickedPalletDetails, totalWeight, carrier };
    });
    console.log(JSON.stringify(result));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
