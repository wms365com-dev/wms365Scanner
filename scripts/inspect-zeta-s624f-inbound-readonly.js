const { Client } = require("pg");

const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const ACCOUNT_ID = "1566";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const SKU = "S624F";
const TRACKING = "877479752015";
const RECEIPT_DATE = "2026-09-25";

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("WMS365 production target mismatch");
    }
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const account = await client.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
        const warehouse = await client.query("select id,code,name,is_active from fulfillment_locations where id=$1", [WAREHOUSE_ID]);
        const assignment = await client.query(
            `select account_name,fulfillment_location_id,is_primary,allow_inbound,allow_outbound,allow_storage
             from company_fulfillment_locations where account_name=$1 and fulfillment_location_id=$2`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        const item = await client.query(
            `select account_name,sku,description,upc,tracking_level,units_per_case,lot_tracked,
                    expiration_tracked,blocked,item_type
             from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, SKU]
        );
        const duplicates = await client.query(
            `select i.inbound_code,i.status,i.reference_number,i.carrier_name,i.expected_date::text,
                    i.received_at::text,l.sku,l.expected_quantity,l.received_quantity
             from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
             where i.account_name=$1 and l.sku=$2
               and (i.reference_number ilike '%' || $3 || '%'
                    or i.notes ilike '%' || $3 || '%'
                    or i.received_at::date=$4::date)
             order by i.id`,
            [ACCOUNT, SKU, TRACKING, RECEIPT_DATE]
        );
        const recent = await client.query(
            `select i.inbound_code,i.status,i.reference_number,i.carrier_name,i.expected_date::text,
                    i.received_at::text,l.sku,l.expected_quantity,l.received_quantity,
                    coalesce(l.received_location,'') received_location
             from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
             left join portal_inbound_receipt_allocations a on a.inbound_id=i.id and a.line_id=l.id
             where i.account_name=$1 and i.fulfillment_location_id=$2
             order by i.id desc,a.id limit 20`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        const inventory = await client.query(
            `select i.location,sum(i.quantity)::integer quantity,coalesce(b.is_pickable,true) is_pickable,
                    coalesce(b.location_type,'STORAGE') location_type,b.fulfillment_location_id
             from inventory_lines i left join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2
             group by i.location,b.is_pickable,b.location_type,b.fulfillment_location_id order by i.location`,
            [ACCOUNT, SKU]
        );
        const portalAvailability = await client.query(
            `with reserved as (
                select l.sku,coalesce(sum(l.requested_quantity),0)::integer quantity
                from portal_orders o join portal_order_lines l on l.order_id=o.id
                where o.account_name=$1 and l.sku=$2
                  and o.status=any($3::text[])
                group by l.sku
             )
             select c.sku,c.blocked,
                    coalesce(sum(case when coalesce(b.is_pickable,true)=true
                                      and coalesce(b.location_type,'STORAGE') not in ('RECEIVING_STAGE','QUARANTINE','DAMAGED','HOLD')
                                      then il.quantity else 0 end),0)::integer pickable_quantity,
                    coalesce(max(r.quantity),0)::integer reserved_quantity,
                    greatest(coalesce(sum(case when coalesce(b.is_pickable,true)=true
                                               and coalesce(b.location_type,'STORAGE') not in ('RECEIVING_STAGE','QUARANTINE','DAMAGED','HOLD')
                                               then il.quantity else 0 end),0)-coalesce(max(r.quantity),0),0)::integer available_quantity
             from item_catalog c
             left join inventory_lines il on il.account_name=c.account_name and il.sku=c.sku
             left join bin_locations b on b.code=il.location
             left join reserved r on r.sku=c.sku
             where c.account_name=$1 and c.sku=$2
             group by c.sku,c.blocked`,
            [ACCOUNT, SKU, ["RELEASED", "PICKED", "STAGED"]]
        );
        await client.query("rollback");
        if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
            throw new Error("ZETA account identity mismatch");
        }
        if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE || !warehouse.rows[0].is_active) {
            throw new Error("Mississauga warehouse identity mismatch");
        }
        console.log(JSON.stringify({
            scope: { account: account.rows[0], warehouse: warehouse.rows[0], assignment: assignment.rows },
            item: item.rows,
            duplicates: duplicates.rows,
            recent: recent.rows,
            inventory: inventory.rows,
            portalAvailability: portalAvailability.rows
        }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
