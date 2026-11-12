const { Client } = require("pg");

const ACCOUNT = "ALCONA TRADING LTD";

async function main() {
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await db.connect();
    try {
        await db.query("begin read only");
        const account = await db.query(
            "select id,name,is_active from owner_accounts where name=$1",
            [ACCOUNT]
        );
        if (account.rowCount !== 1 || !account.rows[0].is_active) {
            throw new Error("Exact active Alcona account was not found.");
        }
        const stock = await db.query(
            `select i.sku,c.description,c.tracking_level,c.unit_uom,c.uom_label,c.units_per_case,
                    fl.id warehouse_id,fl.code warehouse_code,fl.name warehouse_name,
                    coalesce(sum(i.quantity),0)::numeric on_hand
             from inventory_lines i
             join item_catalog c on c.account_name=i.account_name and c.sku=i.sku
             left join bin_locations b on b.code=i.location
             left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
             where i.account_name=$1
             group by i.sku,c.description,c.tracking_level,c.unit_uom,c.uom_label,c.units_per_case,
                      fl.id,fl.code,fl.name
             having coalesce(sum(i.quantity),0) <> 0
             order by i.sku,fl.code`,
            [ACCOUNT]
        );
        const allocations = await db.query(
            `select a.sku,o.fulfillment_location_id warehouse_id,
                    coalesce(sum(a.allocated_quantity),0)::numeric reserved
             from portal_order_allocations a
             join portal_orders o on o.id=a.order_id
             where o.account_name=$1
               and o.status in ('RELEASED','PICKING','PICKED','STAGED')
             group by a.sku,o.fulfillment_location_id`,
            [ACCOUNT]
        );
        await db.query("rollback");
        const reserved = new Map(allocations.rows.map((row) => [
            `${row.sku}:${row.warehouse_id || ""}`,
            Number(row.reserved)
        ]));
        const rows = stock.rows.map((row) => {
            const held = reserved.get(`${row.sku}:${row.warehouse_id || ""}`) || 0;
            return {
                sku: row.sku,
                description: row.description,
                trackingLevel: row.tracking_level,
                unitUom: row.unit_uom,
                uomLabel: row.uom_label,
                unitsPerCase: row.units_per_case,
                warehouseCode: row.warehouse_code || "UNSCOPED",
                warehouseName: row.warehouse_name || "Unscoped",
                onHand: Number(row.on_hand),
                reserved: held,
                available: Number(row.on_hand) - held
            };
        });
        const totalsByUom = {};
        for (const row of rows) {
            const uom = row.unitUom || row.trackingLevel || "UNKNOWN";
            totalsByUom[uom] ||= { onHand: 0, reserved: 0, available: 0 };
            totalsByUom[uom].onHand += row.onHand;
            totalsByUom[uom].reserved += row.reserved;
            totalsByUom[uom].available += row.available;
        }
        console.log(JSON.stringify({
            account: account.rows[0].name,
            accountId: account.rows[0].id,
            skuCount: new Set(rows.map((row) => row.sku)).size,
            totalsByUom,
            rows
        }));
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
