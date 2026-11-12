const { Client } = require("pg");

const ACCOUNT = "ALCONA TRADING LTD";
const SKU = "MS26062403";
const LOCATION = "WHS01-REC";

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        const [account, bin, inventory, alconaBins, pallets, item, warehouse] = await Promise.all([
            db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            db.query("select * from bin_locations where code=$1", [LOCATION]),
            db.query("select * from inventory_lines where location=$1 order by account_name,sku,lot_number", [LOCATION]),
            db.query(
                `select b.code,b.location_type,b.is_pickable,b.account_name,b.fulfillment_location_id,
                        coalesce(sum(i.quantity),0)::numeric quantity
                 from bin_locations b left join inventory_lines i on i.location=b.code and i.account_name=$1
                 where b.account_name=$1 or exists(select 1 from inventory_lines x where x.location=b.code and x.account_name=$1)
                 group by b.code,b.location_type,b.is_pickable,b.account_name,b.fulfillment_location_id
                 order by b.code`, [ACCOUNT]),
            db.query(
                `select pallet_code,account_name,sku,location,cases_on_pallet,inventory_quantity
                 from pallet_records where account_name=$1 and sku=$2 order by pallet_code`, [ACCOUNT, SKU]),
            db.query(
                `select sku,tracking_level,unit_uom,uom_label,blocked,item_type
                 from item_catalog where account_name=$1 and sku=$2`, [ACCOUNT, SKU]),
            db.query(
                `select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
                 from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1 order by fl.id`, [ACCOUNT])
        ]);
        await db.query("rollback");
        console.log(JSON.stringify({
            account: account.rows,
            sourceBin: bin.rows,
            sourceInventory: inventory.rows.map((row) => ({
                accountName: row.account_name, sku: row.sku, quantity: Number(row.quantity),
                lotNumber: row.lot_number, expirationDate: row.expiration_date
            })),
            alconaBins: alconaBins.rows,
            palletRecords: pallets.rows,
            item: item.rows,
            warehouses: warehouse.rows
        }));
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
