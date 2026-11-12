const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const result = await client.query(
            `select i.*,fl.code warehouse_code,fl.name warehouse_name
             from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
             where i.inbound_code=$1`, ["INB-000162"]
        );
        if (result.rows.length !== 1) throw new Error("Expected exactly one inbound.");
        const inbound = result.rows[0];
        const lines = await client.query(
            `select l.*,c.description,c.tracking_level,c.upc,c.lot_tracked,c.expiration_tracked,c.blocked
             from portal_inbound_lines l left join item_catalog c on c.account_name=$2 and c.sku=l.sku
             where l.inbound_id=$1 order by l.line_number,l.id`, [inbound.id, inbound.account_name]
        );
        const pallets = await client.query("select * from portal_inbound_pallet_labels where inbound_id=$1 order by id", [inbound.id]);
        const bins = await client.query(
            `select code,location_type,is_pickable,account_name,fulfillment_location_id
             from bin_locations where account_name=$1 and fulfillment_location_id=1 order by code limit 40`, [inbound.account_name]
        );
        const contacts = await client.query("select name,legal_name,email,portal_login_email from owner_accounts where name=$1", [inbound.account_name]);
        console.log(JSON.stringify({ inbound, lines: lines.rows, pallets: pallets.rows, bins: bins.rows, company: contacts.rows }, null, 2));
        await client.query("rollback");
    } finally { await client.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
