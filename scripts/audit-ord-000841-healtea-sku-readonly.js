const { Pool } = require("pg");
const { getPortalInventorySummary } = require("../server");

const ORDER_CODE = "ORD-000841";
const SKU = "20628693486143";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const orderResult = await pool.query(
            `select o.id, o.order_code, o.account_name, o.status, o.shipping_reference, o.po_number,
                    o.fulfillment_location_id, fl.code as warehouse_code, fl.name as warehouse_name,
                    o.requested_ship_date, o.created_at, o.released_at
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             where o.order_code = $1`,
            [ORDER_CODE]
        );
        if (orderResult.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found.`);
        const order = orderResult.rows[0];

        const [lines, inventory, activeOrders, allocations, kits, portalInventory] = await Promise.all([
            pool.query(
                `select l.id, l.sku, c.description, l.requested_quantity, c.tracking_level
                 from portal_order_lines l
                 left join item_catalog c on c.account_name = $2 and c.sku = l.sku
                 where l.order_id = $1 order by l.id`,
                [order.id, order.account_name]
            ),
            pool.query(
                `select i.id, i.location, i.quantity, i.lot_number, i.expiration_date, i.tracking_level,
                        b.account_name as bin_account_name, b.location_type, b.is_pickable,
                        b.fulfillment_location_id, fl.code as warehouse_code, fl.name as warehouse_name
                 from inventory_lines i
                 left join bin_locations b on b.code = i.location
                 left join fulfillment_locations fl on fl.id = b.fulfillment_location_id
                 where i.account_name = $1 and i.sku = $2
                 order by i.location, i.id`,
                [order.account_name, SKU]
            ),
            pool.query(
                `select o.id, o.order_code, o.status, o.fulfillment_location_id,
                        fl.code as warehouse_code, fl.name as warehouse_name,
                        o.shipping_reference, o.po_number, o.requested_ship_date,
                        o.created_at, o.picked_at, o.staged_at, l.requested_quantity
                 from portal_orders o
                 join portal_order_lines l on l.order_id = o.id
                 left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
                 where o.account_name = $1 and l.sku = $2
                   and o.status = any($3::text[])
                 order by o.order_code`,
                [order.account_name, SKU, ["RELEASED", "PICKED", "STAGED"]]
            ),
            pool.query(
                `select o.order_code, o.status, o.fulfillment_location_id,
                        a.inventory_line_id, a.location, a.allocated_quantity
                 from portal_order_allocations a
                 join portal_orders o on o.id = a.order_id
                 where o.account_name = $1 and a.sku = $2
                   and o.status = any($3::text[])
                 order by o.order_code, a.id`,
                [order.account_name, SKU, ["RELEASED", "PICKED", "STAGED"]]
            ),
            pool.query(
                `select k.request_code, k.status, a.location, a.allocated_quantity
                 from portal_kitting_allocations a
                 join portal_kitting_requests k on k.id = a.kitting_request_id
                 where k.account_name = $1 and a.sku = $2
                   and k.status in ('SUBMITTED', 'IN_PROGRESS')
                 order by k.request_code, a.id`,
                [order.account_name, SKU]
            ),
            getPortalInventorySummary(order.account_name, pool, {
                fulfillmentLocationId: order.fulfillment_location_id
            })
        ]);

        const line = lines.rows.find((row) => String(row.sku).trim().toUpperCase() === SKU);
        const requested = Number(line?.requested_quantity || 0);
        const activeReserved = activeOrders.rows.reduce((sum, row) => sum + Number(row.requested_quantity || 0), 0);
        const allocated = allocations.rows.reduce((sum, row) => sum + Number(row.allocated_quantity || 0), 0);
        const kitReserved = kits.rows.reduce((sum, row) => sum + Number(row.allocated_quantity || 0), 0);
        const pickableInventory = inventory.rows.filter((row) => row.is_pickable !== false && !["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE", "QC"].includes(String(row.location_type || "STORAGE").toUpperCase()));
        const pickableOnHand = pickableInventory.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        const selectedWarehouseOnHand = pickableInventory
            .filter((row) => String(row.fulfillment_location_id || "") === String(order.fulfillment_location_id || ""))
            .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        const selectedWarehouseReserved = activeOrders.rows
            .filter((row) => String(row.fulfillment_location_id || "") === String(order.fulfillment_location_id || ""))
            .reduce((sum, row) => sum + Number(row.requested_quantity || 0), 0);

        console.log(JSON.stringify({
            order,
            orderLines: lines.rows,
            skuInventory: inventory.rows,
            activeOrders: activeOrders.rows,
            activeAllocations: allocations.rows,
            activeKittingAllocations: kits.rows,
            selectedWarehousePortalInventory: portalInventory.find((item) => item.sku === SKU) || null,
            totals: {
                orderRequestedQuantity: requested,
                pickableOnHand,
                activeSalesReserved: activeReserved,
                activeAllocated: allocated,
                activeKittingReserved: kitReserved,
                accountAvailableBeforeDraft: Math.max(pickableOnHand - activeReserved - kitReserved, 0),
                accountAvailableAfterDraft: Math.max(pickableOnHand - activeReserved - kitReserved - requested, 0),
                selectedWarehouseOnHand,
                selectedWarehouseReserved,
                selectedWarehouseAvailableBeforeDraft: Math.max(selectedWarehouseOnHand - selectedWarehouseReserved - kitReserved, 0),
                selectedWarehouseAvailableAfterDraft: Math.max(selectedWarehouseOnHand - selectedWarehouseReserved - kitReserved - requested, 0)
            }
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
