const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const OPEN_STATUSES = ["DRAFT", "RELEASED", "PICKED", "STAGED"];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const summaryResult = await client.query(
            `select o.status,
                    count(*)::integer order_count,
                    count(*) filter (where coalesce(labels.label_count,0)>0)::integer with_uploaded_label,
                    count(*) filter (where coalesce(labels.label_count,0)=0)::integer without_uploaded_label,
                    count(*) filter (where nullif(trim(o.shipped_tracking_reference),'') is not null)::integer with_tracking_entered,
                    coalesce(sum(lines.total_quantity),0)::integer total_units
             from portal_orders o
             left join lateral (
                select count(*)::integer label_count
                from portal_order_documents d
                where d.order_id=o.id and d.document_category='SHIPPING_LABEL'
             ) labels on true
             left join lateral (
                select coalesce(sum(l.requested_quantity),0)::integer total_quantity
                from portal_order_lines l where l.order_id=o.id
             ) lines on true
             where o.account_name=$1 and o.status=any($2::text[])
             group by o.status
             order by case o.status when 'STAGED' then 1 when 'PICKED' then 2 when 'RELEASED' then 3 else 4 end`,
            [ACCOUNT, OPEN_STATUSES]
        );
        const oldestResult = await client.query(
            `select o.order_code,o.status,o.created_at,o.released_at,o.requested_ship_date,
                    o.ship_to_name,o.ship_to_city,o.ship_to_state,
                    coalesce(labels.label_count,0)::integer uploaded_label_count,
                    coalesce(lines.total_quantity,0)::integer total_units
             from portal_orders o
             left join lateral (
                select count(*)::integer label_count
                from portal_order_documents d
                where d.order_id=o.id and d.document_category='SHIPPING_LABEL'
             ) labels on true
             left join lateral (
                select coalesce(sum(l.requested_quantity),0)::integer total_quantity
                from portal_order_lines l where l.order_id=o.id
             ) lines on true
             where o.account_name=$1 and o.status=any($2::text[])
             order by o.created_at asc,o.id asc
             limit 10`,
            [ACCOUNT, OPEN_STATUSES]
        );
        const totals = summaryResult.rows.reduce((result, row) => ({
            orderCount: result.orderCount + Number(row.order_count),
            withUploadedLabel: result.withUploadedLabel + Number(row.with_uploaded_label),
            withoutUploadedLabel: result.withoutUploadedLabel + Number(row.without_uploaded_label),
            withTrackingEntered: result.withTrackingEntered + Number(row.with_tracking_entered),
            totalUnits: result.totalUnits + Number(row.total_units)
        }), { orderCount: 0, withUploadedLabel: 0, withoutUploadedLabel: 0, withTrackingEntered: 0, totalUnits: 0 });
        console.log(JSON.stringify({
            generatedAt: new Date().toISOString(),
            accountName: ACCOUNT,
            totals,
            byStatus: summaryResult.rows,
            oldestOutstandingOrders: oldestResult.rows
        }, null, 2));
        await client.query("rollback");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
