const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const OLD_SKU = "RTC-4OZ-12";
const NEW_SKU = "RTC-4OZ-EA";

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        const skuColumns = await client.query(
            `select table_name, column_name
             from information_schema.columns
             where table_schema = 'public'
               and column_name in ('sku', 'local_sku', 'source_sku', 'target_sku')
             order by table_name, column_name`
        );
        const tableColumns = await client.query(
            `select table_name, array_agg(column_name order by ordinal_position) as columns
             from information_schema.columns
             where table_schema = 'public'
             group by table_name`
        );
        const columnsByTable = new Map(tableColumns.rows.map((row) => [row.table_name, row.columns]));
        const references = [];
        for (const entry of skuColumns.rows) {
            const columns = columnsByTable.get(entry.table_name) || [];
            const accountColumn = columns.includes("account_name") ? "account_name" : null;
            const alias = accountColumn ? ` and ${quoteIdentifier(accountColumn)} = $2` : "";
            const params = accountColumn ? [OLD_SKU, ACCOUNT] : [OLD_SKU];
            const result = await client.query(
                `select count(*)::integer as row_count
                 from ${quoteIdentifier(entry.table_name)}
                 where ${quoteIdentifier(entry.column_name)} = $1${alias}`,
                params
            );
            if (Number(result.rows[0]?.row_count || 0) > 0) {
                references.push({
                    table: entry.table_name,
                    column: entry.column_name,
                    accountScoped: Boolean(accountColumn),
                    rowCount: Number(result.rows[0].row_count)
                });
            }
        }

        const items = await client.query(
                `select sku, description, tracking_level, unit_uom, units_per_case, upc, created_at, updated_at
                 from item_catalog where account_name = $1 and sku = any($2::text[]) order by sku`,
                [ACCOUNT, [OLD_SKU, NEW_SKU]]
            );
        const inventory = await client.query(
                `select id, sku, location, quantity, tracking_level, lot_number, expiration_date, updated_at
                 from inventory_lines where account_name = $1 and sku = any($2::text[]) order by sku, location, id`,
                [ACCOUNT, [OLD_SKU, NEW_SKU]]
            );
        const orders = await client.query(
                `select o.order_code, o.status, o.created_at, o.released_at, o.shipped_at,
                        l.id as line_id, l.sku, l.requested_quantity,
                        coalesce(sum(a.allocated_quantity), 0)::integer as allocated_quantity
                 from portal_orders o
                 join portal_order_lines l on l.order_id = o.id
                 left join portal_order_allocations a on a.order_line_id = l.id
                 where o.account_name = $1 and l.sku = any($2::text[])
                 group by o.order_code, o.status, o.created_at, o.released_at, o.shipped_at,
                          l.id, l.sku, l.requested_quantity
                 order by o.order_code`,
                [ACCOUNT, [OLD_SKU, NEW_SKU]]
            );
        const mappings = await client.query(
                `select m.id, m.external_sku, m.local_sku, m.local_quantity_multiplier, m.note,
                        i.integration_name, i.store_identifier
                 from store_sku_mappings m
                 join store_integrations i on i.id = m.integration_id
                 where m.account_name = $1 and m.local_sku = any($2::text[])
                 order by m.external_sku`,
                [ACCOUNT, [OLD_SKU, NEW_SKU]]
            );
        const pallets = await client.query(
                `select id, pallet_code, sku, description, location, cases_on_pallet,
                        inventory_quantity, inventory_tracking_level, label_date
                 from pallet_records where account_name = $1 and sku = any($2::text[]) order by id`,
                [ACCOUNT, [OLD_SKU, NEW_SKU]]
            );
        const inbounds = await client.query(
                `select i.inbound_code, i.status, l.id as line_id, l.sku, l.expected_quantity,
                        l.received_quantity, l.received_location
                 from portal_inbounds i
                 join portal_inbound_lines l on l.inbound_id = i.id
                 where i.account_name = $1 and l.sku = any($2::text[])
                 order by i.inbound_code, l.id`,
                [ACCOUNT, [OLD_SKU, NEW_SKU]]
            );

        console.log(JSON.stringify({
            account: ACCOUNT,
            proposed: { oldSku: OLD_SKU, newSku: NEW_SKU, description: "Rancher's Tallow Chips - 4 oz", trackingLevel: "UNIT", unitUom: "EA", unitsPerCase: 12 },
            references,
            items: items.rows,
            inventory: inventory.rows,
            orders: orders.rows,
            mappings: mappings.rows,
            pallets: pallets.rows,
            inbounds: inbounds.rows
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
