const { Pool } = require("pg");

const REQUEST_CODE = "KIT-000016";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const requestResult = await pool.query(
            `select k.*, fl.code as warehouse_code, fl.name as warehouse_name
             from portal_kitting_requests k
             left join fulfillment_locations fl on fl.id = k.fulfillment_location_id
             where k.request_code = $1
             limit 1`,
            [REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found.`);
        const request = requestResult.rows[0];
        const allocations = await pool.query(
            `select a.id, a.sku, a.location, a.lot_number, a.expiration_date,
                    a.allocated_quantity, a.inventory_line_id, i.quantity as on_hand_quantity,
                    b.location_type, b.is_pickable, b.fulfillment_location_id
             from portal_kitting_allocations a
             left join inventory_lines i on i.id = a.inventory_line_id
             left join bin_locations b on b.code = a.location
             where a.kitting_request_id = $1
             order by a.id`,
            [request.id]
        );
        const targetInventory = await pool.query(
            `select i.id, i.sku, i.location, i.quantity, i.tracking_level,
                    b.account_name as bin_account_name, b.location_type, b.is_pickable, b.fulfillment_location_id
             from inventory_lines i
             left join bin_locations b on b.code = i.location
             where i.account_name = $1 and i.sku = $2
             order by b.is_pickable desc, i.quantity desc, i.id`,
            [request.account_name, request.target_sku]
        );
        const compatibleBins = await pool.query(
            `select code, location_type, is_pickable, fulfillment_location_id
             from bin_locations
             where account_name = $1
               and fulfillment_location_id = $2
               and is_pickable = true
               and coalesce(location_type, 'STORAGE') not in ('HOLD','INVESTIGATION','DAMAGED','QUARANTINE','RECEIVING_STAGE')
             order by code
             limit 20`,
            [request.account_name, request.fulfillment_location_id]
        );
        const ledgerResult = await pool.query(
            `select sku, location, transaction_type, quantity_delta, quantity_before, quantity_after,
                    source_type, source_id, server_timestamp
             from inventory_transactions
             where account_name = $1 and source_type = 'PORTAL_KITTING_REQUEST' and source_id = $2
             order by id`,
            [request.account_name, REQUEST_CODE]
        );
        const emailResult = await pool.query(
            `select status, provider, to_addresses, bcc_addresses, subject, sent_at, failed_at, error_message
             from email_delivery_log
             where source_ref = $1
             order by created_at desc
             limit 5`,
            [REQUEST_CODE]
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
                warehouseId: String(request.fulfillment_location_id || ""),
                warehouseCode: request.warehouse_code,
                warehouseName: request.warehouse_name,
                requestedBy: request.requested_by_email,
                notes: request.notes
            },
            allocations: allocations.rows,
            targetInventory: targetInventory.rows,
            compatiblePickableBins: compatibleBins.rows,
            inventoryLedger: ledgerResult.rows,
            emailDelivery: emailResult.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
