const {
    APP_USER_ROLES,
    getPortalOrderById,
    reallocatePortalOrderToActualPalletLocations,
    safeDeductInventoryLineQuantity,
    syncWarehouseShipmentsForOrder,
    upsertInventoryLine,
    withTransaction
} = require("../server");

const APPLY = process.argv.includes("--apply");
const REQUIRED_CONFIRMATION = "APPROVED_ORD_000886_PALLET_CORRECTION";
const ORDER_CODE = "ORD-000886";
const ACCOUNT = "ALCONA TRADING LTD";
const WAREHOUSE_CODE = "WHS01";
// Keep the original pallet identity by matching each corrected bin to its saved weight.
const PALLETS = [
    { palletNumber: 1, location: "DI04AB", weight: 2317, weightUom: "LB" },
    { palletNumber: 2, location: "DI06AB", weight: 2314, weightUom: "LB" },
    { palletNumber: 3, location: "DI02AB", weight: 2323, weightUom: "LB" },
    { palletNumber: 4, location: "DJ44AB", weight: 2311, weightUom: "LB" }
];
const PHYSICAL_MOVES = [
    { fromLocation: "DJ26AB", toLocation: "DI04AB" },
    { fromLocation: "DJ30AA", toLocation: "DI06AB" },
    { fromLocation: "DJ30AB", toLocation: "DI02AB" }
];
const ACTOR = {
    id: null,
    email: "support@wms365.co",
    full_name: "WMS365 Support",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function loadOrder(client, { lock = false } = {}) {
    const result = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                o.picked_pallet_details,fl.code warehouse_code
         from portal_orders o
         left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.order_code=$1
         limit 1${lock ? " for update of o" : ""}`,
        [ORDER_CODE]
    );
    if (result.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found.`);
    const row = result.rows[0];
    if (row.account_name !== ACCOUNT) throw new Error(`Order belongs to ${row.account_name}, not ${ACCOUNT}.`);
    if (row.warehouse_code !== WAREHOUSE_CODE) throw new Error(`Order warehouse is ${row.warehouse_code}, not ${WAREHOUSE_CODE}.`);
    if (!['PICKED', 'STAGED'].includes(row.status)) throw new Error(`Order status ${row.status} cannot receive a pallet-pick correction.`);
    return row;
}

async function main() {
    if (APPLY && process.env.CONFIRM_ORD_000886_PALLET_CORRECTION !== REQUIRED_CONFIRMATION) {
        throw new Error(`Set CONFIRM_ORD_000886_PALLET_CORRECTION=${REQUIRED_CONFIRMATION} before --apply.`);
    }

    const result = await withTransaction(async (client) => {
        const row = await loadOrder(client, { lock: APPLY });
        const order = await getPortalOrderById(client, row.id, ACCOUNT);
        if (!APPLY) {
            const allocationResult = await client.query(
                `select a.id,a.order_line_id,a.inventory_line_id,a.sku,a.location,a.lot_number,
                        a.expiration_date,a.allocated_quantity,i.quantity as inventory_quantity
                 from portal_order_allocations a
                 left join inventory_lines i on i.id=a.inventory_line_id
                 where a.order_id=$1
                 order by a.order_line_id,a.id`,
                [row.id]
            );
            const requestedLocations = PALLETS.map((pallet) => pallet.location);
            const targetInventoryResult = await client.query(
                `select i.id,i.sku,i.location,i.lot_number,i.expiration_date,i.quantity,
                        coalesce(bl.location_type,'STORAGE') as location_type,
                        coalesce(bl.is_pickable,true) as is_pickable,
                        coalesce(bl.account_name,'') as bin_account_name,
                        fl.code as warehouse_code
                 from inventory_lines i
                 left join bin_locations bl on upper(bl.code)=upper(i.location)
                 left join fulfillment_locations fl on fl.id=bl.fulfillment_location_id
                 where i.account_name=$1
                   and upper(i.location)=any($2::text[])
                 order by i.location,i.sku,i.lot_number,i.id`,
                [ACCOUNT, requestedLocations]
            );
            return {
                mode: "audit",
                orderCode: row.order_code,
                accountName: row.account_name,
                warehouseCode: row.warehouse_code,
                status: row.status,
                currentPallets: row.picked_pallet_details,
                requestedPallets: PALLETS,
                allocations: allocationResult.rows,
                requestedBinInventory: targetInventoryResult.rows
            };
        }

        const sourceResult = await client.query(
            `select i.*
             from inventory_lines i
             where i.account_name=$1
               and upper(i.location)=any($2::text[])
             order by i.location,i.id
             for update of i`,
            [ACCOUNT, PHYSICAL_MOVES.map((move) => move.fromLocation)]
        );
        const sourceByLocation = new Map(sourceResult.rows.map((source) => [String(source.location).toUpperCase(), source]));
        const stagedMoves = [];
        for (const move of PHYSICAL_MOVES) {
            const source = sourceByLocation.get(move.fromLocation);
            if (!source || source.sku !== "MS26053103" || Number(source.quantity) !== 1) {
                throw new Error(`${move.fromLocation} no longer has the expected single pallet of MS26053103.`);
            }
            await upsertInventoryLine(client, {
                accountName: ACCOUNT,
                location: move.toLocation,
                sku: source.sku,
                upc: source.upc || "",
                lotNumber: source.lot_number || "",
                expirationDate: source.expiration_date || "",
                trackingLevel: source.tracking_level,
                quantity: 1
            }, {
                transactionType: "MOVE_LOCATION",
                sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION",
                sourceId: row.id,
                fulfillmentLocationId: row.fulfillment_location_id,
                appUser: ACTOR,
                source: "web_admin",
                idempotencyKey: `ord-000886-location-correction-${move.fromLocation}-to-${move.toLocation}`
            });
            stagedMoves.push({ ...move, source });
        }

        const changedAllocations = await reallocatePortalOrderToActualPalletLocations(client, order, PALLETS, ACTOR);
        for (const move of stagedMoves) {
            await safeDeductInventoryLineQuantity(client, move.source, 1, {
                actionLabel: `record the physical pallet move from ${move.fromLocation} to ${move.toLocation}`,
                transactionType: "MOVE_LOCATION",
                sourceType: "PORTAL_ORDER_PALLET_LOCATION_CORRECTION",
                sourceId: row.id,
                fulfillmentLocationId: row.fulfillment_location_id,
                appUser: ACTOR,
                source: "web_admin",
                idempotencyKey: `ord-000886-location-correction-${move.fromLocation}-to-${move.toLocation}`
            });
        }
        await client.query(
            `update portal_orders
             set picked_pallet_details=$2::jsonb,
                 outbound_total_pallets=$3,
                 routing_total_weight=$4,
                 routing_weight_uom='LB',
                 updated_at=now()
             where id=$1`,
            [row.id, JSON.stringify(PALLETS), PALLETS.length, PALLETS.reduce((sum, pallet) => sum + pallet.weight, 0)]
        );
        const updated = await getPortalOrderById(client, row.id, ACCOUNT);
        await syncWarehouseShipmentsForOrder(client, updated, { status: row.status });
        await client.query(
            `insert into activity_log (type,title,details,created_at)
             values ('order',$1,$2,now())`,
            [
                `Corrected pallet pick details for ${ORDER_CODE}`,
                `${ACCOUNT} | ${PALLETS.map((pallet) => `Pallet ${pallet.palletNumber}: ${pallet.location} ${pallet.weight} LB`).join(", ")} | WMS365 Support`
            ]
        );
        return {
            mode: "applied",
            orderCode: updated.orderCode,
            status: updated.status,
            pallets: updated.pickedPalletDetails,
            totalWeight: updated.routingTotalWeight,
            weightUom: updated.routingWeightUom,
            changedAllocations
        };
    });
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
