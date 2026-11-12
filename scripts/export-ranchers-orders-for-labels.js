const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const accounts = await client.query("select name from owner_accounts where upper(name) like '%RANCHER%CHIP%' order by name");
        if (accounts.rowCount !== 1) throw new Error(`Expected one Rancher's Chips account; found ${accounts.rowCount}.`);
        const accountName = accounts.rows[0].name;
        const orders = await client.query(
            `select
                o.id,o.order_code,o.status,o.po_number,o.shipping_reference,o.requested_ship_date,
                o.order_type,o.shipment_method,o.contact_name,o.contact_phone,o.ship_to_name,o.ship_to_phone,
                o.ship_to_address1,o.ship_to_address2,o.ship_to_city,o.ship_to_state,o.ship_to_postal_code,
                o.ship_to_country,o.order_notes,o.created_at,o.released_at,o.picked_at,o.staged_at,o.shipped_at,
                o.shipped_carrier_name,o.shipped_tracking_reference,o.fulfillment_location_id,
                fl.code warehouse_code,fl.name warehouse_name,
                soi.external_order_id,si.store_identifier,si.provider
             from portal_orders o
             left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             left join store_order_imports soi on soi.portal_order_id=o.id
             left join store_integrations si on si.id=soi.integration_id
             where o.account_name=$1
             order by o.created_at,o.id`,
            [accountName]
        );
        const orderIds = orders.rows.map((row) => row.id);
        const lines = orderIds.length ? await client.query(
            `select
                l.id,l.order_id,l.line_number,l.sku,l.requested_quantity,
                c.description,c.tracking_level,c.uom_label,c.unit_uom,c.units_per_case,c.upc
             from portal_order_lines l
             left join portal_orders o on o.id=l.order_id
             left join item_catalog c on c.account_name=o.account_name and c.sku=l.sku
             where l.order_id=any($1::bigint[])
             order by l.order_id,l.line_number,l.id`,
            [orderIds]
        ) : { rows: [] };
        const mappings = await client.query(
            `select m.local_sku,m.external_sku,m.local_quantity_multiplier,m.note,i.provider,i.store_identifier
             from store_sku_mappings m join store_integrations i on i.id=m.integration_id
             where m.account_name=$1 order by m.external_sku`,
            [accountName]
        );
        const outputDir = path.join(process.cwd(), "outputs", "ranchers-orders-shipping-labels");
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, "ranchers-orders.json");
        fs.writeFileSync(outputPath, JSON.stringify({
            generatedAt: new Date().toISOString(),
            accountName,
            orders: orders.rows,
            lines: lines.rows,
            mappings: mappings.rows
        }, null, 2));
        console.log(JSON.stringify({ outputPath, accountName, orderCount: orders.rowCount, lineCount: lines.rows.length, mappingCount: mappings.rowCount }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
