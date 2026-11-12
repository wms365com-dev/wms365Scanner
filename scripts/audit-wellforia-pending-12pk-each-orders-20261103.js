const { Pool } = require("pg");

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const [orders, stock, kit] = await Promise.all([
            pool.query(`
                select o.id,o.order_code,o.status,o.fulfillment_location_id,o.portal_access_id,
                       count(l.id)::int line_count,
                       sum(l.requested_quantity)::int total_quantity,
                       json_agg(json_build_object('sku',l.sku,'quantity',l.requested_quantity)
                                order by l.line_number) lines
                from portal_orders o join portal_order_lines l on l.order_id=o.id
                where o.account_name='WELLFORIA HEALTH INC'
                  and o.status='DRAFT'
                  and exists (select 1 from portal_order_lines x where x.order_id=o.id and x.sku='WW-12PK-EA')
                group by o.id order by o.created_at,o.id
            `),
            pool.query(`
                select coalesce(sum(i.quantity),0)::int pickable_on_hand,
                       coalesce((select sum(a.allocated_quantity)::int
                                 from portal_order_allocations a
                                 join portal_order_lines l on l.id=a.order_line_id
                                 join portal_orders o on o.id=l.order_id
                                 where o.account_name='WELLFORIA HEALTH INC'
                                   and o.status in ('RELEASED','PICKED','STAGED')
                                   and l.sku='WW-12PK-EA'),0)::int active_allocated
                from inventory_lines i join bin_locations b on b.code=i.location
                where i.account_name='WELLFORIA HEALTH INC' and i.sku='WW-12PK-EA'
                  and b.fulfillment_location_id=1 and b.is_pickable=true
            `),
            pool.query(`
                select request_code,status,source_sku,source_quantity,target_sku,target_quantity,completed_at
                from portal_kitting_requests
                where account_name='WELLFORIA HEALTH INC' and request_code='KIT-000031'
            `)
        ]);
        const s = stock.rows[0];
        console.log(JSON.stringify({
            exactAccount: "WELLFORIA HEALTH INC", warehouseId: 1,
            kit: kit.rows[0] || null,
            available: Number(s.pickable_on_hand) - Number(s.active_allocated),
            orders: orders.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}
main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
