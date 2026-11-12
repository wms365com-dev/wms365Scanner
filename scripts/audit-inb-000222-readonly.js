const { Client } = require("pg");

const CODE = "INB-000222";

async function main() {
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false,
    });
    await db.connect();
    try {
        await db.query("begin read only");
        const inbound = await db.query(
            `select i.*, fl.code warehouse_code, fl.name warehouse_name
             from portal_inbounds i
             left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
             where i.inbound_code=$1`,
            [CODE]
        );
        if (inbound.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
        const row = inbound.rows[0];
        const [account, membership, lines, documents, pallets, receipts, ledger, bins, emails] = await Promise.all([
            db.query("select id,name,is_active from owner_accounts where name=$1", [row.account_name]),
            db.query(
                `select cfl.*, fl.code, fl.name, fl.is_active
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1 and fl.id=$2`,
                [row.account_name, row.fulfillment_location_id]
            ),
            db.query(
                `select l.*, c.description,c.upc,c.tracking_level,c.units_per_case,c.item_type,
                        c.blocked,c.lot_tracked,c.expiration_tracked
                 from portal_inbound_lines l
                 left join item_catalog c on c.account_name=$2 and c.sku=l.sku
                 where l.inbound_id=$1 order by l.line_number,l.id`,
                [row.id, row.account_name]
            ),
            db.query(
                `select id,file_name,file_type,document_category,created_at
                 from portal_inbound_documents where inbound_id=$1 order by id`,
                [row.id]
            ),
            db.query(
                `select id,line_id,pallet_code,sku,cases_on_pallet,expected_quantity,actual_quantity,
                        pallet_status,pallet_type,is_mixed,billable,notes
                 from portal_inbound_pallet_labels where inbound_id=$1 order by id`,
                [row.id]
            ),
            db.query(
                `select * from portal_inbound_receipt_allocations where inbound_id=$1 order by line_id,allocation_number,id`,
                [row.id]
            ),
            db.query(
                `select id,transaction_type,source_type,source_id,sku,location,quantity_delta,server_timestamp
                 from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text order by id`,
                [String(row.id)]
            ),
            db.query(
                `select code,account_name,fulfillment_location_id,location_type,is_pickable
                 from bin_locations where account_name=$1 and fulfillment_location_id=$2 order by code`,
                [row.account_name, row.fulfillment_location_id]
            ),
            db.query(
                `select status,source_type,source_ref,delivery_key,message_id,to_addresses,cc_addresses,bcc_addresses,sent_at
                 from email_delivery_log
                 where account_name=$1 and (source_ref=$2 or metadata::text ilike $3)
                 order by id`,
                [row.account_name, CODE, `%${CODE}%`]
            ),
        ]);
        await db.query("rollback");
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            inbound: row,
            account: account.rows,
            warehouseMembership: membership.rows,
            lines: lines.rows,
            documents: documents.rows,
            pallets: pallets.rows,
            receiptAllocations: receipts.rows,
            ledger: ledger.rows,
            companyBins: bins.rows,
            relatedEmails: emails.rows,
        }, null, 2));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
