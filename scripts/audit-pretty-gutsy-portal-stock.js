const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({
        connectionString,
        ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }
    });
    const client = await pool.connect();
    try {
        await client.query("begin read only");
        const accounts = await client.query(`
            select name
            from owner_accounts
            where upper(name) like '%GUTS%'
            order by name
        `);
        for (const account of accounts.rows) {
            const warehouses = await client.query(`
                select fl.id, fl.code, fl.name
                from company_fulfillment_locations cfl
                join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
                where cfl.account_name = $1
                  and fl.is_active = true
                order by fl.name
            `, [account.name]);
            const inventory = await client.query(`
                select i.sku, i.location, i.quantity,
                    coalesce(bl.is_pickable, true) as is_pickable,
                    coalesce(bl.location_type, 'STORAGE') as location_type,
                    fl.code as mapped_warehouse_code,
                    fl.name as mapped_warehouse_name
                from inventory_lines i
                left join bin_locations bl on upper(bl.code) = upper(i.location)
                left join company_fulfillment_locations cfl on cfl.account_name = i.account_name
                left join fulfillment_locations fl
                  on fl.id = cfl.fulfillment_location_id
                 and (upper(i.location) = upper(fl.code) or upper(i.location) like upper(fl.code) || '-%')
                where i.account_name = $1
                  and i.quantity <> 0
                order by i.sku, i.location
            `, [account.name]);
            const reservations = await client.query(`
                select pol.sku, coalesce(sum(pol.requested_quantity), 0)::integer as reserved_quantity
                from portal_orders po
                join portal_order_lines pol on pol.order_id = po.id
                where po.account_name = $1
                  and po.status = any($2::text[])
                group by pol.sku
                order by pol.sku
            `, [account.name, ["RELEASED", "PICKED", "STAGED"]]);
            const portalVisibleStock = await client.query(`
                with assigned_scope as (
                    select cfl.account_name,
                        count(*)::integer as assigned_warehouse_count,
                        min(cfl.fulfillment_location_id) as sole_fulfillment_location_id
                    from company_fulfillment_locations cfl
                    join fulfillment_locations fl
                      on fl.id = cfl.fulfillment_location_id
                     and fl.is_active = true
                    where cfl.account_name = $1
                    group by cfl.account_name
                ), reserved as (
                    select po.fulfillment_location_id, pol.sku,
                        coalesce(sum(pol.requested_quantity), 0)::integer as reserved_quantity
                    from portal_orders po
                    join portal_order_lines pol on pol.order_id = po.id
                    where po.account_name = $1
                      and po.status = any($3::text[])
                      and po.fulfillment_location_id is not null
                    group by po.fulfillment_location_id, pol.sku
                )
                select fl.code as warehouse_code, i.sku,
                    coalesce(sum(case
                        when coalesce(bl.is_pickable, true) = true
                         and coalesce(bl.location_type, 'STORAGE') <> all($2::text[])
                        then i.quantity else 0 end), 0)::integer as pickable_quantity,
                    coalesce(r.reserved_quantity, 0)::integer as reserved_quantity,
                    greatest(coalesce(sum(case
                        when coalesce(bl.is_pickable, true) = true
                         and coalesce(bl.location_type, 'STORAGE') <> all($2::text[])
                        then i.quantity else 0 end), 0) - coalesce(r.reserved_quantity, 0), 0)::integer as available_quantity
                from company_fulfillment_locations cfl
                join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id and fl.is_active = true
                join assigned_scope scope on scope.account_name = cfl.account_name
                join inventory_lines i on i.account_name = cfl.account_name
                 and (
                    upper(i.location) = upper(fl.code)
                    or upper(i.location) like upper(fl.code) || '-%'
                    or (
                        scope.assigned_warehouse_count = 1
                        and scope.sole_fulfillment_location_id = cfl.fulfillment_location_id
                        and not exists (
                            select 1 from fulfillment_locations named_warehouse
                            where named_warehouse.is_active = true
                              and (upper(i.location) = upper(named_warehouse.code)
                                or upper(i.location) like upper(named_warehouse.code) || '-%')
                        )
                    )
                 )
                left join bin_locations bl on bl.code = i.location
                left join reserved r on r.fulfillment_location_id = cfl.fulfillment_location_id and r.sku = i.sku
                group by fl.code, i.sku, r.reserved_quantity
                having greatest(coalesce(sum(case
                    when coalesce(bl.is_pickable, true) = true
                     and coalesce(bl.location_type, 'STORAGE') <> all($2::text[])
                    then i.quantity else 0 end), 0) - coalesce(r.reserved_quantity, 0), 0) > 0
                order by fl.code, i.sku
            `, [account.name, ["RECEIVING_STAGE", "DOCK", "QA_HOLD", "STAGING", "HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE"], ["RELEASED", "PICKED", "STAGED"]]);
            const portalAccess = await client.query(`
                select count(*)::integer as configured_users,
                    count(*) filter (where pva.is_active)::integer as active_users,
                    count(*) filter (where pva.is_active and coalesce(
                        (pva.portal_permissions ->> 'inventory-only')::boolean,
                        (oa.feature_flags ->> 'CUSTOMER_PORTAL')::boolean,
                        true
                    ))::integer as active_inventory_users,
                    count(*) filter (where pva.is_active and coalesce(
                        (pva.portal_permissions ->> 'order-entry')::boolean,
                        (oa.feature_flags ->> 'ORDER_ENTRY')::boolean,
                        (oa.feature_flags ->> 'INBOUND_NOTICES')::boolean,
                        true
                    ))::integer as active_order_entry_users
                from portal_vendor_access pva
                join owner_accounts oa on oa.name = pva.account_name
                where pva.account_name = $1
            `, [account.name]);
            console.log(JSON.stringify({
                account: account.name,
                warehouses: warehouses.rows,
                inventory: inventory.rows,
                reservations: reservations.rows,
                portalVisibleStock: portalVisibleStock.rows,
                portalAccess: portalAccess.rows[0]
            }, null, 2));
        }
        await client.query("rollback");
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
