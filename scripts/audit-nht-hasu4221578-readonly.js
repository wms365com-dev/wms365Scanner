const { Client } = require("pg");

const accountName = "NORTH HIMALAYAN TRADERS";
const container = "HASU4221578";
const referenceNumber = "269845896";
const locations = [
    "DE02AA", "DE04AA", "DE06AA", "DE08AA", "DE10AA",
    "DE12AA", "DE14AA", "DE16AA", "DE18AA", "DE20AA",
    "DE22AA", "DE24AA", "DE26AA", "DE28AA", "DE30AA",
    "DE32AA", "DE34AA", "DE36AA", "DE38AA", "DE40AA"
];
const skus = ["SALTEREX-CMPRSD2026/04", "SALTEREX-NATRL2026/04"];

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const [company, warehouses, inbounds, items, bins, inventory] = await Promise.all([
            client.query("select id,name,legal_name,account_code from owner_accounts where name=$1", [accountName]),
            client.query(`select fl.id,fl.code,fl.name,cfl.is_primary,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
                          from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                          where cfl.account_name=$1 order by cfl.is_primary desc,fl.code`, [accountName]),
            client.query(`select id,inbound_code,account_name,status,reference_number,carrier_name,expected_date,received_at,fulfillment_location_id,notes
                          from portal_inbounds
                          where upper(reference_number) in (upper($1),upper($2))
                             or upper(notes) like '%' || upper($1) || '%'
                          order by id`, [container, referenceNumber]),
            client.query(`select id,account_name,sku,description,tracking_level,uom_label,lot_tracked,expiration_tracked
                          from item_catalog where sku=any($1::text[]) order by account_name,sku`, [skus]),
            client.query(`select id,code,note,location_type,is_pickable,account_name,fulfillment_location_id
                          from bin_locations where code=any($1::text[]) order by code`, [locations]),
            client.query(`select id,account_name,location,sku,lot_number,expiration_date,tracking_level,quantity
                          from inventory_lines where location=any($1::text[]) order by location,account_name,sku`, [locations])
        ]);
        console.log(JSON.stringify({
            company: company.rows,
            warehouses: warehouses.rows,
            possibleDuplicateInbounds: inbounds.rows,
            items: items.rows,
            bins: bins.rows,
            inventory: inventory.rows,
            missingLocations: locations.filter((code) => !bins.rows.some((row) => row.code === code))
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
