const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");

    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        const [scope, items, inbounds, receipts, inventory] = await Promise.all([
            db.query(
                `select oa.id as owner_account_id,oa.name,fl.id as warehouse_id,fl.code as warehouse_code,
                        fl.is_active,cfl.allow_inbound,cfl.allow_storage
                 from owner_accounts oa
                 join company_fulfillment_locations cfl on cfl.account_name=oa.name
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where oa.name=$1
                 order by fl.id`,
                [ACCOUNT]
            ),
            db.query(
                `select sku,description,upc,tracking_level,uom_label,unit_uom,units_per_case,
                        lot_tracked,expiration_tracked,blocked
                 from item_catalog where account_name=$1 order by blocked,sku`,
                [ACCOUNT]
            ),
            db.query(
                `select i.id,i.inbound_code,i.status,i.reference_number,i.expected_date::text,
                        i.fulfillment_location_id,fl.code as warehouse_code,i.carrier_name,
                        i.created_at,i.received_at,
                        coalesce(jsonb_agg(jsonb_build_object(
                            'lineId',l.id,'sku',l.sku,'expectedQuantity',l.expected_quantity,
                            'receivedQuantity',l.received_quantity,'lotNumber',l.lot_number,
                            'expirationDate',l.expiration_date
                        ) order by l.id) filter (where l.id is not null),'[]'::jsonb) as lines
                 from portal_inbounds i
                 left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
                 left join portal_inbound_lines l on l.inbound_id=i.id
                 where i.account_name=$1
                   and (i.status in ('DRAFT','SUBMITTED','ARRIVED','RECEIVED_PENDING_PUTAWAY')
                        or i.expected_date >= current_date - interval '7 days')
                 group by i.id,fl.code order by i.id desc`,
                [ACCOUNT]
            ),
            db.query(
                `select i.inbound_code,i.status,i.reference_number,i.fulfillment_location_id,
                        to_char(i.received_at at time zone 'America/New_York','YYYY-MM-DD HH24:MI:SS') as received_et,
                        l.sku,l.received_quantity,l.lot_number,l.expiration_date::text
                 from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
                 where i.account_name=$1
                   and (i.received_at at time zone 'America/New_York')::date=current_date
                 order by i.id,l.id`,
                [ACCOUNT]
            ),
            db.query(
                `select i.sku,i.lot_number,i.expiration_date::text,i.location,
                        sum(i.quantity)::numeric as quantity,b.fulfillment_location_id,b.is_pickable,b.location_type
                 from inventory_lines i left join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.quantity<>0
                 group by i.sku,i.lot_number,i.expiration_date,i.location,b.fulfillment_location_id,b.is_pickable,b.location_type
                 order by i.sku,i.expiration_date,i.lot_number,i.location`,
                [ACCOUNT]
            )
        ]);

        console.log(JSON.stringify({
            mode: "READ_ONLY",
            localDate: (await db.query("select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') as value")).rows[0].value,
            scope: scope.rows,
            items: items.rows,
            candidateInbounds: inbounds.rows,
            receiptsToday: receipts.rows,
            inventory: inventory.rows
        }, null, 2));
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
