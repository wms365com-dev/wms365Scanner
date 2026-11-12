const { Client } = require("pg");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const INBOUND_CODE = "INB-000188";
const WAREHOUSE_ID = 1;

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const [inbound, inventory, accountBins, unassignedBins] = await Promise.all([
            client.query(
                `select i.id,i.inbound_code,i.status,i.account_name,i.fulfillment_location_id,i.expected_date,i.received_at,
                        json_agg(json_build_object('id',l.id,'sku',l.sku,'expected',l.expected_quantity,
                            'received',l.received_quantity) order by l.line_number) lines
                 from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
                 where i.inbound_code=$1 and i.account_name=$2
                 group by i.id`,
                [INBOUND_CODE, ACCOUNT]
            ),
            client.query(
                `select il.location,il.sku,il.quantity,il.lot_number,b.location_type,b.is_pickable,
                        b.account_name,b.fulfillment_location_id
                 from inventory_lines il
                 left join bin_locations b on b.code=il.location
                 where il.account_name=$1
                 order by il.quantity desc,il.location
                 limit 50`,
                [ACCOUNT]
            ),
            client.query(
                `select code,location_type,is_pickable,account_name,fulfillment_location_id
                 from bin_locations
                 where account_name=$1 and fulfillment_location_id=$2
                 order by is_pickable desc,code limit 50`,
                [ACCOUNT, WAREHOUSE_ID]
            ),
            client.query(
                `select b.code,b.location_type,b.is_pickable,b.account_name,b.fulfillment_location_id,
                        coalesce(sum(il.quantity),0)::integer stock_quantity,
                        count(distinct il.account_name) filter (where il.quantity<>0)::integer stock_accounts
                 from bin_locations b
                 left join inventory_lines il on il.location=b.code
                 where b.fulfillment_location_id=$1 and b.is_pickable=true
                   and (b.account_name is null or b.account_name='')
                 group by b.code,b.location_type,b.is_pickable,b.account_name,b.fulfillment_location_id
                 having count(distinct il.account_name) filter (where il.quantity<>0)=0
                 order by b.code limit 30`,
                [WAREHOUSE_ID]
            )
        ]);
        console.log(JSON.stringify({
            inbound: inbound.rows[0] || null,
            spectrumInventory: inventory.rows,
            spectrumBins: accountBins.rows,
            emptyUnassignedPickableBins: unassignedBins.rows
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
