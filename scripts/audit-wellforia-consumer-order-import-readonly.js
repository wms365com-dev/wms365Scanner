const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const CANDIDATE_SKUS = ["WW-12PK-EA", "TP-WW-6PK-UPC", "WW-6PK-EA"];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const [accounts, warehouses, items, inventory, recentOrders] = await Promise.all([
            pool.query(
                `select name,is_active from owner_accounts where name=$1`,
                [ACCOUNT]
            ),
            pool.query(
                `select fl.id,fl.code,fl.name,fl.is_active,cfl.is_primary,cfl.allow_storage
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1 and fl.code=$2`,
                [ACCOUNT, WAREHOUSE]
            ),
            pool.query(
                `select sku,description,upc,unit_uom,units_per_case,tracking_level,blocked
                 from item_catalog
                 where account_name=$1 and (sku=any($2::text[]) or description ilike '%Whoopsie%')
                 order by sku`,
                [ACCOUNT, CANDIDATE_SKUS]
            ),
            pool.query(
                `select i.sku,
                        coalesce(sum(i.quantity) filter (where b.is_pickable=true and fl.code=$2),0)::integer as pickable_on_hand,
                        coalesce((select sum(a.allocated_quantity)::integer
                                  from portal_order_allocations a
                                  join portal_order_lines l on l.id=a.order_line_id
                                  join portal_orders o on o.id=l.order_id
                                  where o.account_name=$1 and o.status in ('RELEASED','PICKED','STAGED')
                                    and l.sku=i.sku),0)::integer as active_allocated
                 from inventory_lines i
                 left join bin_locations b on b.code=i.location
                 left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
                 where i.account_name=$1 and (i.sku=any($3::text[]) or i.sku in (
                     select sku from item_catalog where account_name=$1 and description ilike '%Whoopsie%'
                 ))
                 group by i.sku order by i.sku`,
                [ACCOUNT, WAREHOUSE, CANDIDATE_SKUS]
            ),
            pool.query(
                `select o.id,o.order_code,o.po_number,o.shipping_reference,o.status,
                        o.ship_to_name,o.ship_to_phone,o.ship_to_postal_code,
                        o.requested_ship_date,o.created_at,
                        json_agg(json_build_object('sku',l.sku,'quantity',l.requested_quantity)
                                 order by l.line_number) as lines
                 from portal_orders o
                 join portal_order_lines l on l.order_id=o.id
                 where o.account_name=$1 and o.created_at >= now() - interval '120 days'
                 group by o.id
                 order by o.created_at desc`,
                [ACCOUNT]
            )
        ]);
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            expectedAccount: ACCOUNT,
            expectedWarehouse: WAREHOUSE,
            accounts: accounts.rows,
            warehouses: warehouses.rows,
            items: items.rows,
            inventory: inventory.rows,
            recentOrders: recentOrders.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

module.exports = { main };

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message || error);
        process.exit(1);
    });
}
