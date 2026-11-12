const { Pool } = require("pg");

const CODE = "INB-000212";
const ACCOUNT = "PURE FOODS BY ESTEE";

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const inbound = await pool.query(
            `select i.*,fl.code warehouse_code,fl.name warehouse_name
             from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
             where i.inbound_code=$1`,
            [CODE]
        );
        if (inbound.rowCount !== 1 || inbound.rows[0].account_name !== ACCOUNT) throw new Error(`${CODE} was not found uniquely for Pure Foods.`);
        const row = inbound.rows[0];
        const [account, membership, lines, documents, pallets, receipts, ledger, inventory, allocations, contacts, preferences, delivery] = await Promise.all([
            pool.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            pool.query(
                `select cfl.*,fl.code,fl.name,fl.is_active from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1 and fl.id=$2`, [ACCOUNT, row.fulfillment_location_id]),
            pool.query(
                `select l.*,c.description,c.upc,c.tracking_level,c.units_per_case,c.item_type,c.blocked,c.lot_tracked,c.expiration_tracked
                 from portal_inbound_lines l left join item_catalog c on c.account_name=$2 and c.sku=l.sku
                 where l.inbound_id=$1 order by l.line_number,l.id`, [row.id, ACCOUNT]),
            pool.query(
                `select id,file_name,file_type,document_category,created_at from portal_inbound_documents
                 where inbound_id=$1 order by id`, [row.id]),
            pool.query(
                `select id,line_id,pallet_code,sku,cases_on_pallet,expected_quantity,actual_quantity,pallet_status,notes
                 from portal_inbound_pallet_labels where inbound_id=$1 order by id`, [row.id]),
            pool.query("select * from portal_inbound_receipt_allocations where inbound_id=$1 order by line_id,allocation_number,id", [row.id]),
            pool.query(
                `select id,transaction_type,source_type,source_id,sku,location,quantity_delta,server_timestamp
                 from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text order by id`, [String(row.id)]),
            pool.query(
                `select i.id,i.sku,i.location,i.quantity,i.tracking_level,b.is_pickable,b.location_type,b.fulfillment_location_id
                 from inventory_lines i left join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=any($2::text[]) order by i.sku,i.id`, [ACCOUNT,["140","150"]]),
            pool.query(
                `select o.order_code,o.status,a.sku,a.allocated_quantity,a.location
                 from portal_order_allocations a join portal_orders o on o.id=a.order_id
                 where o.account_name=$1 and a.sku=any($2::text[]) and o.status in ('RELEASED','PICKING','PICKED','STAGED')
                 order by a.sku,o.order_code`, [ACCOUNT,["140","150"]]),
            pool.query(
                `select id,email,is_active from portal_vendor_access where account_name=$1 order by id`, [ACCOUNT]),
            pool.query(
                `select email,notification_type,is_subscribed from customer_email_preferences
                 where account_name=$1 and notification_type in ('PORTAL_INBOUND_STATUS','*')`, [ACCOUNT]),
            pool.query(
                `select status,message_id,to_addresses,cc_addresses,bcc_addresses,sent_at from email_delivery_log
                 where delivery_key=$1`, [`INBOUND-CLOSED-${CODE}-PURE-FOODS-20261026`]),
        ]);
        console.log(JSON.stringify({ mode: "READ_ONLY", inbound: row, account: account.rows,
            warehouseMembership: membership.rows, lines: lines.rows, documents: documents.rows,
            pallets: pallets.rows, receiptAllocations: receipts.rows, ledger: ledger.rows,
            inventory: inventory.rows, activeOrderAllocations: allocations.rows,
            contacts: contacts.rows, preferences: preferences.rows, priorDelivery: delivery.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
