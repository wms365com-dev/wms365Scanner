const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    const params = ["HEALTEA", "30628693486072"];
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const queries = {
            item: `select sku,description,tracking_level,units_per_case from item_catalog where account_name=$1 and sku=$2`,
            stock: `select location,quantity,lot_number,expiration_date from inventory_lines where account_name=$1 and sku=$2 order by location,id`,
            inbounds: `select i.inbound_code,i.reference_number,i.status,i.expected_date::text,i.received_at,
                l.expected_quantity,l.received_quantity,l.received_location,l.lot_number,l.expiration_date::text
                from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
                where i.account_name=$1 and l.sku=$2 order by i.received_at nulls last,i.id`,
            kits: `select request_code,status,source_sku,source_quantity,target_sku,target_quantity,completed_at,notes
                from portal_kitting_requests where account_name=$1 and (source_sku=$2 or target_sku=$2 or components_json::text like '%' || $2 || '%') order by id`,
            orders: `select o.order_code,o.status,o.confirmed_ship_date::text,l.requested_quantity,
                (select coalesce(sum(s.shipped_quantity),0) from portal_order_shipment_lines s where s.order_line_id=l.id) shipped_quantity,
                (select coalesce(sum(a.allocated_quantity),0) from portal_order_allocations a where a.order_line_id=l.id) allocated_quantity
                from portal_orders o join portal_order_lines l on l.order_id=o.id
                where o.account_name=$1 and l.sku=$2 order by o.id`,
            ledger: `select (server_timestamp at time zone 'America/Toronto')::date::text recorded_date,
                transaction_type,source_type,source_id,location,sum(quantity_delta)::integer quantity_delta,min(server_timestamp) recorded_at
                from inventory_transactions where account_name=$1 and sku=$2
                group by 1,transaction_type,source_type,source_id,location order by min(server_timestamp),source_id`
        };
        const output = {};
        for (const [key, query] of Object.entries(queries)) output[key] = (await client.query(query, params)).rows;
        const monthlyShipping = {};
        for (const order of output.orders.filter(o => o.status === "SHIPPED")) {
            const month = (order.confirmed_ship_date || "UNDATED").slice(0, 7);
            const group = monthlyShipping[month] ||= { orders: 0, confirmedCases: 0, missingLineConfirmation: [] };
            group.orders += 1;
            group.confirmedCases += Number(order.shipped_quantity);
            if (!Number(order.shipped_quantity)) group.missingLineConfirmation.push({ order: order.order_code, orderedCases: order.requested_quantity });
        }
        console.log(JSON.stringify({
            item: output.item, inbounds: output.inbounds, kits: output.kits, stock: output.stock,
            monthlyShipping, openOrders: output.orders.filter(o => ["RELEASED", "PICKED", "STAGED", "DRAFT"].includes(o.status)),
            otherStockChanges: output.ledger.filter(t => Number(t.quantity_delta) !== 0 && !["SHIPPING", "RECEIVING"].includes(t.transaction_type)),
            ledgerTotals: output.ledger.reduce((totals,t) => { totals[t.transaction_type] = (totals[t.transaction_type] || 0) + Number(t.quantity_delta); return totals; }, {})
        }, null, 2));
        await client.query("rollback");
    } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
