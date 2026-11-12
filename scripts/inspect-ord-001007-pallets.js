const { Pool } = require("pg");

const ORDER = "ORD-001007";
const LOCATIONS = ["DJ14AA", "DJ16AA", "DJ16AB", "DJ02AA"];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const pool = new Pool({ connectionString, ssl: false, max: 1 });
    const client = await pool.connect();
    try {
        await client.query("begin read only");
        const orders = await client.query(
            `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                    o.shipment_method,o.picked_pallet_details,o.outbound_total_pallets,
                    o.routing_total_weight,o.routing_weight_uom,o.picked_at,o.staged_at,o.shipped_at,
                    o.po_number,o.shipping_reference,o.order_notes,o.ship_to_name,o.ship_to_address1,
                    o.ship_to_address2,o.ship_to_city,o.ship_to_state,o.ship_to_postal_code,
                    o.ship_to_country,o.requested_ship_date,o.routing_requested_delivery_date,
                    o.routing_email,o.shipped_carrier_name,o.shipped_tracking_reference,
                    fl.code warehouse_code
             from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1`, [ORDER]
        );
        if (orders.rowCount !== 1) throw new Error("Order is missing or ambiguous.");
        const order = orders.rows[0];
        const lines = await client.query(
            `select l.id,l.sku,l.requested_quantity,c.description,c.tracking_level
             from portal_order_lines l left join item_catalog c
               on c.account_name=$2 and c.sku=l.sku
             where l.order_id=$1 order by l.line_number,l.id`, [order.id, order.account_name]
        );
        const allocations = await client.query(
            `select a.id,a.order_line_id,a.inventory_line_id,a.sku,a.location,a.lot_number,
                    a.expiration_date,a.allocated_quantity,i.quantity inventory_quantity,
                    i.lot_number inventory_lot,i.location inventory_location
             from portal_order_allocations a left join inventory_lines i on i.id=a.inventory_line_id
             where a.order_id=$1 order by a.order_line_id,a.id`, [order.id]
        );
        const targets = await client.query(
            `select i.id,i.sku,i.location,i.lot_number,i.expiration_date,i.tracking_level,i.quantity,
                    b.account_name bin_account,b.fulfillment_location_id bin_warehouse_id,
                    b.is_pickable,b.location_type,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                      join portal_orders o on o.id=a.order_id
                      where a.inventory_line_id=i.id and a.order_id<>$3
                        and o.status=any(array['RELEASED','PICKED','STAGED'])),0)::integer other_allocated
             from inventory_lines i left join bin_locations b on upper(b.code)=upper(i.location)
             where i.account_name=$1 and upper(i.location)=any($2::text[])
             order by i.location,i.sku,i.lot_number,i.id`,
            [order.account_name, LOCATIONS, order.id]
        );
        const relevantInventory = await client.query(
            `select i.id,i.sku,i.location,i.lot_number,i.expiration_date,i.tracking_level,i.quantity,
                    b.account_name bin_account,b.fulfillment_location_id bin_warehouse_id,
                    b.is_pickable,b.location_type,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                      join portal_orders o on o.id=a.order_id
                      where a.inventory_line_id=i.id and o.status=any(array['RELEASED','PICKED','STAGED'])),0)::integer committed
             from inventory_lines i left join bin_locations b on upper(b.code)=upper(i.location)
             where i.account_name=$1 and (i.sku=any($2::text[]) or upper(i.location)=any($3::text[]))
             order by i.sku,i.location,i.id`,
            [order.account_name, ["MS26053103", "MS26062403"], LOCATIONS]
        );
        const catalog = await client.query(
            `select sku,description,tracking_level,lot_tracked,expiration_tracked,blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [order.account_name, ["MS26053103", "MS26062403", "MS26060402G"]]
        );
        const bins = await client.query(
            `select code,account_name,fulfillment_location_id,is_pickable,location_type
             from bin_locations where upper(code)=any($1::text[]) order by code`, [LOCATIONS]
        );
        const batchReferences = await client.query(
            `select 'INVENTORY' source,i.sku,i.lot_number,i.location reference,i.quantity::text quantity
             from inventory_lines i where i.account_name=$1
               and (i.sku ilike '%260624%' or i.lot_number ilike '%260624%')
             union all
             select 'INBOUND' source,l.sku,l.lot_number,coalesce(i.inbound_code,'') reference,
                    coalesce(l.received_quantity,0)::text quantity
             from portal_inbound_lines l join portal_inbounds i on i.id=l.inbound_id
             where i.account_name=$1 and (l.sku ilike '%260624%' or l.lot_number ilike '%260624%')
             order by source,reference`, [order.account_name]
        );
        const tasks = await client.query(
            `select task_type,status,count(*)::integer count from warehouse_tasks
             where source_type='PORTAL_ORDER' and source_id=$1 group by task_type,status`, [order.id]
        );
        const shipments = await client.query(
            `select id,status,fulfillment_location_id,carrier_name,total_weight,weight_uom,
                    delivery_date,tracking_reference from warehouse_shipments where order_id=$1 order by id`, [order.id]
        );
        const appointment = await client.query(
            `select status,appointment_date,window_start,window_end,responder_name,responder_note
             from order_routing_requests where order_id=$1`, [order.id]
        );
        const documents = await client.query(
            `select id,file_name,document_category,created_at from portal_order_documents where order_id=$1 order by id`, [order.id]
        );
        const priorEmails = await client.query(
            `select id,status,subject,source_type,source_ref,delivery_key,sent_at
             from email_delivery_log where source_ref=$1 or subject ilike $2 order by id desc limit 20`,
            [ORDER, `%${ORDER}%`]
        );
        await client.query("rollback");
        console.log(JSON.stringify({ order, lines: lines.rows, allocations: allocations.rows,
            targetInventory: targets.rows, relevantInventory: relevantInventory.rows,
            catalog: catalog.rows, bins: bins.rows, batchReferences: batchReferences.rows,
            tasks: tasks.rows, shipments: shipments.rows, appointment: appointment.rows,
            documents: documents.rows, priorEmails: priorEmails.rows }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
