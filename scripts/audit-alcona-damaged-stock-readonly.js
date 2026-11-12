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
        const rows = await db.query(
            `select i.sku,i.location,i.lot_number,i.expiration_date,i.quantity,
                    b.location_type,b.is_pickable,b.note,
                    fl.code warehouse_code,fl.name warehouse_name
             from inventory_lines i
             left join bin_locations b on b.code=i.location
             left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
             where i.account_name=$1 and i.quantity <> 0
             order by i.sku,i.location,i.lot_number`,
            [ACCOUNT]
        );
        const allocations = await db.query(
            `select a.sku,a.location,coalesce(sum(a.allocated_quantity),0)::numeric quantity
             from portal_order_allocations a
             join portal_orders o on o.id=a.order_id
             where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED')
             group by a.sku,a.location order by a.sku,a.location`,
            [ACCOUNT]
        );
        await db.query("rollback");
        const flagged = rows.rows.filter((row) => {
            const text = `${row.location || ""} ${row.location_type || ""} ${row.note || ""}`;
            return !row.is_pickable || /damage|damaged|quarantine|hold|blocked|reject|exception/i.test(text);
        });
        console.log(JSON.stringify({
            account: ACCOUNT,
            inventoryLineCount: rows.rowCount,
            flaggedLineCount: flagged.length,
            flaggedQuantity: flagged.reduce((sum, row) => sum + Number(row.quantity), 0),
            pickableQuantity: rows.rows.filter((row) => row.is_pickable)
                .reduce((sum, row) => sum + Number(row.quantity), 0),
            activeAllocatedQuantity: allocations.rows.reduce((sum, row) => sum + Number(row.quantity), 0),
            pickableAvailableQuantity: rows.rows.filter((row) => row.is_pickable)
                .reduce((sum, row) => sum + Number(row.quantity), 0)
                - allocations.rows.reduce((sum, row) => sum + Number(row.quantity), 0),
            allocations: allocations.rows.map((row) => ({
                sku: row.sku,
                location: row.location,
                quantity: Number(row.quantity)
            })),
            flagged: flagged.map((row) => ({
                sku: row.sku,
                quantity: Number(row.quantity),
                location: row.location,
                locationType: row.location_type,
                pickable: row.is_pickable,
                warehouseCode: row.warehouse_code,
                warehouseName: row.warehouse_name
            }))
        }));
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
