const { Client } = require("pg");

const ORDER_CODE = "ORD-001154";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await db.connect();
    try {
        await db.query("begin transaction isolation level repeatable read read only");
        const order = await db.query(
            `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                    o.picking_at,o.picked_at,o.staged_at,o.shipped_at,o.cancelled_at,
                    o.shipped_carrier_name,o.shipped_tracking_reference,
                    fl.code as warehouse_code,fl.name as warehouse_name
             from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1`,
            [ORDER_CODE]
        );
        if (order.rowCount !== 1) throw new Error(`${ORDER_CODE}: expected one order, found ${order.rowCount}.`);
        const row = order.rows[0];
        const lines = await db.query(
                `select id,line_number,sku,requested_quantity from portal_order_lines
                 where order_id=$1 order by line_number`, [row.id]
            );
        const allocations = await db.query(
                `select a.id,a.order_line_id,a.inventory_line_id,a.sku,a.allocated_quantity,
                        a.location,a.lot_number,a.expiration_date,i.quantity as location_on_hand
                 from portal_order_allocations a
                 left join inventory_lines i on i.id=a.inventory_line_id
                 where a.order_id=$1 order by a.id`, [row.id]
            );
        const shipments = await db.query(
                `select id,shipment_code,status,carrier_name,tracking_reference,shipped_at
                 from warehouse_shipments where order_id=$1 order by id`, [row.id]
            );
        const ledger = await db.query(
                `select transaction_type,source_type,source_id,location,sku,quantity_before,
                        quantity_after,quantity_delta,idempotency_key,server_timestamp
                 from inventory_transactions
                 where account_name=$1 and source_id=$2::text
                 order by id`, [row.account_name, String(row.id)]
            );
        const billingRates = await db.query(
                `select c.code,c.category,c.name,c.unit_label,c.default_rate,c.is_active,
                        r.rate,r.is_enabled,r.unit_label as override_unit_label,r.note
                 from billing_fee_catalog c
                 left join owner_billing_rates r on r.fee_code=c.code and r.account_name=$1
                 where c.code='RESTOCKING_FEE'`, [row.account_name]
            );
        const billingEvents = await db.query(
                `select id,event_key,fee_code,quantity,rate,amount,currency_code,status,
                        source_type,source_ref,service_date,note
                 from billing_events
                 where account_name=$1 and (source_ref=$2 or event_key ilike '%' || $2 || '%')
                 order by id`, [row.account_name, ORDER_CODE]
            );
        const enabledRates = await db.query(
            `select r.fee_code,c.category,c.name,coalesce(nullif(r.unit_label,''),c.unit_label) unit_label,
                    r.rate,r.is_enabled,r.note
             from owner_billing_rates r join billing_fee_catalog c on c.code=r.fee_code
             where r.account_name=$1 and r.is_enabled=true and c.is_active=true
             order by c.category,c.name`, [row.account_name]
        );
        const recentComparableBilling = await db.query(
            `select event_key,fee_code,fee_name,unit_label,quantity,rate,amount,currency_code,
                    source_type,source_ref,service_date,status,note
             from billing_events
             where account_name=$1 and status<>'VOID'
               and (fee_code ilike '%PICK%' or fee_code ilike '%RESTOCK%' or fee_category ilike '%RETURN%')
             order by id desc limit 25`, [row.account_name]
        );
        const inventoryAvailability = await db.query(
            `with stock as (
                select i.id,i.location,i.sku,i.lot_number,i.quantity,
                       coalesce(sum(a.allocated_quantity) filter (
                           where po.status in ('RELEASED','PICKING','PICKED','STAGED')
                       ),0)::integer as reserved_quantity
                from inventory_lines i
                left join portal_order_allocations a on a.inventory_line_id=i.id
                left join portal_orders po on po.id=a.order_id
                where i.account_name=$1 and i.sku=$2
                group by i.id,i.location,i.sku,i.lot_number,i.quantity
             )
             select location,sku,lot_number,quantity as on_hand_quantity,reserved_quantity,
                    (quantity-reserved_quantity)::integer as available_quantity
             from stock order by location,lot_number`,
            [row.account_name, lines.rows[0].sku]
        );
        await db.query("rollback");
        console.log(JSON.stringify({ mode: "READ_ONLY", order: row, lines: lines.rows,
            allocations: allocations.rows, shipments: shipments.rows, ledger: ledger.rows,
            restockingRate: billingRates.rows, enabledRates: enabledRates.rows,
            recentComparableBilling: recentComparableBilling.rows,
            inventoryAvailability: inventoryAvailability.rows,
            existingBillingEvents: billingEvents.rows }));
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
