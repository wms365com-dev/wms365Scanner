const { Client } = require("pg");

const ACCOUNT = "ALCONA TRADING LTD";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await db.connect();
    try {
        await db.query("begin transaction isolation level repeatable read read only");
        const account = await db.query(
            "select id,name,is_active from owner_accounts where name=$1",
            [ACCOUNT]
        );
        if (account.rowCount !== 1 || !account.rows[0].is_active) {
            throw new Error("Exact active Alcona account was not found.");
        }
        const rows = await db.query(
            `with line_shipments as (
                select o.id as order_id,o.order_code,o.confirmed_ship_date,o.shipped_at,
                       l.id as order_line_id,l.line_number,l.sku,l.requested_quantity,
                       coalesce(sum(wsl.shipped_quantity),0)::integer as warehouse_shipped_quantity,
                       coalesce((select sum(posl.shipped_quantity)::integer
                                 from portal_order_shipment_lines posl
                                 where posl.order_id=o.id and posl.order_line_id=l.id),0) as portal_shipped_quantity
                from portal_orders o
                join portal_order_lines l on l.order_id=o.id
                left join warehouse_shipments ws on ws.order_id=o.id and ws.status='SHIPPED'
                left join warehouse_shipment_lines wsl on wsl.shipment_id=ws.id and wsl.order_line_id=l.id
                where o.account_name=$1 and o.status='SHIPPED'
                group by o.id,o.order_code,o.confirmed_ship_date,o.shipped_at,
                         l.id,l.line_number,l.sku,l.requested_quantity
             ), normalized as (
                select *,greatest(warehouse_shipped_quantity,portal_shipped_quantity) as shipped_quantity
                from line_shipments
             )
             select order_code,confirmed_ship_date,shipped_at,
                    json_agg(json_build_object(
                        'lineNumber',line_number,'sku',sku,'requestedQuantity',requested_quantity,
                        'shippedQuantity',shipped_quantity
                    ) order by line_number) as lines,
                    sum(requested_quantity)::integer as requested_total,
                    sum(shipped_quantity)::integer as shipped_total,
                    bool_or(shipped_quantity > 4) as any_line_over_four
             from normalized
             group by order_id,order_code,confirmed_ship_date,shipped_at
             having sum(shipped_quantity) > 4 or bool_or(shipped_quantity > 4)
             order by coalesce(confirmed_ship_date,shipped_at::date),order_code`,
            [ACCOUNT]
        );
        const summary = await db.query(
            `select count(*)::integer shipped_order_count,
                    min(coalesce(confirmed_ship_date,shipped_at::date)) first_ship_date,
                    max(coalesce(confirmed_ship_date,shipped_at::date)) last_ship_date
             from portal_orders where account_name=$1 and status='SHIPPED'`,
            [ACCOUNT]
        );
        const quantitySummary = await db.query(
            `with line_shipments as (
                select o.id as order_id,l.id as order_line_id,l.sku,
                       coalesce(sum(wsl.shipped_quantity),0)::integer as warehouse_shipped_quantity,
                       coalesce((select sum(posl.shipped_quantity)::integer
                                 from portal_order_shipment_lines posl
                                 where posl.order_id=o.id and posl.order_line_id=l.id),0) as portal_shipped_quantity
                from portal_orders o
                join portal_order_lines l on l.order_id=o.id
                left join warehouse_shipments ws on ws.order_id=o.id and ws.status='SHIPPED'
                left join warehouse_shipment_lines wsl on wsl.shipment_id=ws.id and wsl.order_line_id=l.id
                where o.account_name=$1 and o.status='SHIPPED'
                group by o.id,l.id,l.sku
             ), normalized as (
                select order_id,sku,greatest(warehouse_shipped_quantity,portal_shipped_quantity) as shipped_quantity
                from line_shipments
             )
             select count(distinct order_id)::integer as shipped_order_count,
                    count(*)::integer as shipped_line_count,
                    coalesce(sum(shipped_quantity),0)::integer as total_shipped_quantity
             from normalized`,
            [ACCOUNT]
        );
        await db.query("rollback");
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            account: ACCOUNT,
            accountId: Number(account.rows[0].id),
            shipmentHistory: summary.rows[0],
            quantitySummary: quantitySummary.rows[0],
            ordersOverFour: rows.rows
        }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
