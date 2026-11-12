const { Client } = require("pg");

const ACCOUNT = "ALCONA TRADING LTD";
const SKUS = ["MS26053103", "MS26062403"];

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        const [account, inventory, allocations, damageBin] = await Promise.all([
            db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            db.query(
                `select i.*,b.location_type,b.is_pickable,b.account_name bin_account,
                        b.fulfillment_location_id
                 from inventory_lines i join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=any($2::text[]) and i.quantity>0
                 order by i.sku,i.location,i.lot_number`,
                [ACCOUNT, SKUS]
            ),
            db.query(
                `select a.sku,a.location,coalesce(sum(a.allocated_quantity),0)::integer allocated
                 from portal_order_allocations a join portal_orders o on o.id=a.order_id
                 where o.account_name=$1 and a.sku=any($2::text[])
                   and o.status in ('RELEASED','PICKING','PICKED','STAGED')
                 group by a.sku,a.location order by a.sku,a.location`,
                [ACCOUNT, SKUS]
            ),
            db.query("select * from bin_locations where code='WHS01-ALCONA-DMG'")
        ]);
        await db.query("rollback");
        const allocatedBySkuLocation = new Map(
            allocations.rows.map((row) => [`${row.sku}\u0000${row.location}`, Number(row.allocated)])
        );
        console.log(JSON.stringify({
            account: account.rows,
            inventory: inventory.rows.map((row) => ({
                id: row.id, sku: row.sku, location: row.location,
                lotNumber: row.lot_number, expirationDate: row.expiration_date,
                quantity: Number(row.quantity), locationType: row.location_type,
                pickable: row.is_pickable, warehouseId: row.fulfillment_location_id,
                allocated: allocatedBySkuLocation.get(`${row.sku}\u0000${row.location}`) || 0,
                free: Number(row.quantity) - (allocatedBySkuLocation.get(`${row.sku}\u0000${row.location}`) || 0)
            })),
            damageBin: damageBin.rows.map((row) => ({
                code: row.code,
                accountName: row.account_name,
                warehouseId: row.fulfillment_location_id,
                locationType: row.location_type,
                pickable: row.is_pickable
            }))
        }));
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
