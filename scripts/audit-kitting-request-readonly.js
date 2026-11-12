const { Pool } = require("pg");

const REQUEST_CODE = String(process.argv[2] || "").trim().toUpperCase();

async function main() {
    if (!/^KIT-\d{6}$/.test(REQUEST_CODE)) throw new Error("Provide a kitting request code such as KIT-000015.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const requestResult = await pool.query(
            `select k.*, fl.code as warehouse_code, fl.name as warehouse_name
             from portal_kitting_requests k
             left join fulfillment_locations fl on fl.id = k.fulfillment_location_id
             where k.request_code = $1 limit 1`,
            [REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found.`);
        const request = requestResult.rows[0];
        const allocations = await pool.query(
            `select a.id, a.sku, a.location, a.lot_number, a.expiration_date,
                    a.allocated_quantity, a.inventory_line_id, i.quantity as on_hand_quantity,
                    i.tracking_level, b.location_type, b.is_pickable, b.fulfillment_location_id
             from portal_kitting_allocations a
             left join inventory_lines i on i.id = a.inventory_line_id
             left join bin_locations b on b.code = a.location
             where a.kitting_request_id = $1 order by a.id`,
            [request.id]
        );
        const targetInventory = await pool.query(
            `select i.id, i.sku, i.location, i.quantity, i.tracking_level,
                    b.account_name as bin_account_name, b.location_type, b.is_pickable,
                    b.fulfillment_location_id
             from inventory_lines i
             left join bin_locations b on b.code = i.location
             where i.account_name = $1 and i.sku = $2
             order by b.is_pickable desc, i.quantity desc, i.id`,
            [request.account_name, request.target_sku]
        );
        const itemSkus = [...new Set([
            request.target_sku,
            ...(Array.isArray(request.components_json) ? request.components_json.map((component) => component.sku) : [])
        ].filter(Boolean))];
        const items = await pool.query(
            `select sku, description, tracking_level, coalesce(unit_uom, '') as unit_uom,
                    coalesce(units_per_case, 0) as units_per_case, coalesce(uom_label, '') as uom_label
             from item_catalog
             where account_name = $1 and sku = any($2::text[])
             order by sku`,
            [request.account_name, itemSkus]
        );
        console.log(JSON.stringify({
            request: {
                id: String(request.id),
                requestCode: request.request_code,
                accountName: request.account_name,
                status: request.status,
                components: request.components_json,
                sourceSku: request.source_sku,
                sourceQuantity: Number(request.source_quantity),
                targetSku: request.target_sku,
                targetQuantity: Number(request.target_quantity),
                warehouseId: request.fulfillment_location_id ? String(request.fulfillment_location_id) : "",
                warehouseCode: request.warehouse_code,
                warehouseName: request.warehouse_name,
                requestedBy: request.requested_by_email,
                notes: request.notes
            },
            allocations: allocations.rows,
            targetInventory: targetInventory.rows,
            items: items.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
