const { Pool } = require("pg");

const COMPONENT_SKUS = ["141", "144", "149"];
const TARGET_SKU = "174";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const accounts = await pool.query(
            `select account_name, count(*)::int as matched
             from item_catalog
             where sku = any($1::text[])
             group by account_name
             having count(distinct sku) = $2
             order by account_name`,
            [[...COMPONENT_SKUS, TARGET_SKU], COMPONENT_SKUS.length + 1]
        );
        if (accounts.rowCount !== 1) {
            throw new Error(`Expected exactly one company owning all four SKUs; found ${accounts.rowCount}.`);
        }
        const account = accounts.rows[0].account_name;
        const items = await pool.query(
            `select sku, description, upc, tracking_level, uom_label, unit_uom, units_per_case, blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [account, [...COMPONENT_SKUS, TARGET_SKU]]
        );
        const inventory = await pool.query(
            `select i.id, i.sku, i.location, i.quantity, i.lot_number, i.expiration_date,
                    i.tracking_level, b.is_pickable, b.location_type, b.fulfillment_location_id,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                              join portal_orders o on o.id=a.order_id
                              where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                    + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                                join portal_kitting_requests k on k.id=a.kitting_request_id
                                where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed_quantity
             from inventory_lines i
             left join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=any($2::text[])
             order by i.sku, i.id`,
            [account, [...COMPONENT_SKUS, TARGET_SKU]]
        );
        const warehouses = await pool.query(
            `select fl.id, fl.code, fl.name, fl.is_active, cfl.allow_storage
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 order by fl.id`,
            [account]
        );
        const activeKits = await pool.query(
            `select request_code,status,purchase_order_reference,source_sku,source_quantity,target_sku,target_quantity,created_at
             from portal_kitting_requests
             where account_name=$1 and status in ('SUBMITTED','IN_PROGRESS')
               and (target_sku=$2 or components_json::text like any($3::text[]))
             order by id`,
            [account, TARGET_SKU, COMPONENT_SKUS.map((sku) => `%\"sku\":\"${sku}\"%`)]
        );
        const componentCommitments = await pool.query(
            `select o.order_code, o.status, a.sku, a.allocated_quantity, a.location,
                    l.requested_quantity
             from portal_order_allocations a
             join portal_orders o on o.id=a.order_id
             left join portal_order_lines l on l.id=a.order_line_id
             where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED')
               and a.sku=any($2::text[])
             order by a.sku, o.order_code, a.id`,
            [account, COMPONENT_SKUS]
        );
        const summary = {};
        for (const sku of [...COMPONENT_SKUS, TARGET_SKU]) {
            const lines = inventory.rows.filter((row) => row.sku === sku);
            summary[sku] = {
                onHand: lines.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
                committed: lines.reduce((sum, row) => sum + Number(row.committed_quantity || 0), 0),
                available: lines.reduce((sum, row) => sum + Math.max(Number(row.quantity || 0) - Number(row.committed_quantity || 0), 0), 0),
                pickableAvailable: lines.filter((row) => row.is_pickable === true && !["HOLD","INVESTIGATION","DAMAGED","QUARANTINE","RECEIVING_STAGE"].includes(String(row.location_type || "").toUpperCase()))
                    .reduce((sum, row) => sum + Math.max(Number(row.quantity || 0) - Number(row.committed_quantity || 0), 0), 0),
                lines
            };
        }
        console.log(JSON.stringify({ mode: "READ_ONLY", account, items: items.rows, warehouses: warehouses.rows, activeKits: activeKits.rows, componentCommitments: componentCommitments.rows, inventory: summary }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
