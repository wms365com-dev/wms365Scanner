const { Client } = require("pg");

const INBOUND_CODE = "INB-000209";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const ACCOUNT_ID = 3918;
const WAREHOUSE_CODE = "GW3PL-MEADOWPINE";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await db.connect();
    try {
        await db.query("begin transaction isolation level repeatable read read only");
        const account = await db.query(
            "select id,name,is_active from owner_accounts where id=$1 and name=$2",
            [ACCOUNT_ID, ACCOUNT]
        );
        if (account.rowCount !== 1 || !account.rows[0].is_active) throw new Error("Pinned Spectrum account is unavailable.");
        const inbound = await db.query(
            `select i.*,fl.code as current_warehouse_code,fl.name as current_warehouse_name
             from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
             where i.inbound_code=$1`, [INBOUND_CODE]
        );
        if (inbound.rowCount !== 1) throw new Error(`${INBOUND_CODE}: expected exactly one inbound.`);
        const row = inbound.rows[0];
        if (row.account_name !== ACCOUNT) throw new Error(`${INBOUND_CODE}: inbound does not belong to Spectrum.`);
        const warehouse = await db.query(
            `select fl.id,fl.code,fl.name,fl.address1,fl.address2,fl.city,fl.state,fl.postal_code,
                    fl.is_active,cfl.is_primary,cfl.allow_inbound,cfl.allow_outbound,
                    cfl.allow_storage,cfl.customer_portal_visible
             from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.code=$2`, [ACCOUNT, WAREHOUSE_CODE]
        );
        if (warehouse.rowCount !== 1 || !warehouse.rows[0].is_active || !warehouse.rows[0].allow_inbound
            || !warehouse.rows[0].allow_storage || !warehouse.rows[0].customer_portal_visible) {
            throw new Error("Spectrum Meadowpine assignment is not ready for receiving.");
        }
        const lines = await db.query(
            `select l.id,l.line_number,l.sku,l.expected_quantity,l.received_quantity,l.received_location,
                    l.lot_number,l.expiration_date,l.pallet_count,l.pallet_codes,
                    c.description,c.tracking_level,c.unit_uom,c.units_per_case,c.lot_tracked,c.blocked
             from portal_inbound_lines l left join item_catalog c
               on c.account_name=$1 and c.sku=l.sku
             where l.inbound_id=$2 order by l.line_number`, [ACCOUNT, row.id]
        );
        const documents = await db.query(
            `select id,file_name,file_type,file_size,document_category,
                    (file_data is not null and octet_length(file_data)>0) as has_file_data
             from portal_inbound_documents where inbound_id=$1 order by id`, [row.id]
        );
        const palletLabels = await db.query(
            `select id,line_id,pallet_code,sku,cases_on_pallet,expected_quantity,
                    actual_quantity,pallet_status,pallet_size_type
             from portal_inbound_pallet_labels where inbound_id=$1 order by id`, [row.id]
        );
        const receiptAllocations = await db.query(
            `select id,line_id,quantity,location,lot_number,expiration_date,pallet_reference,
                    pallet_size_type,pallet_weight,pallet_weight_uom
             from portal_inbound_receipt_allocations where inbound_id=$1 order by id`, [row.id]
        );
        const ledger = await db.query(
            `select transaction_type,location,sku,lot_number,quantity_delta,idempotency_key
             from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text order by id`,
            [String(row.id)]
        );
        const recipients = await db.query(
            `select count(distinct lower(email))::integer as recipient_count
             from portal_vendor_access
             where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>''`, [ACCOUNT]
        );
        const priorEmails = await db.query(
            `select status,to_addresses,cc_addresses,bcc_addresses,message_id,sent_at
             from email_delivery_log
             where account_name=$1 and source_ref=$2 order by id`, [ACCOUNT, INBOUND_CODE]
        );
        await db.query("rollback");
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            inbound: {
                id: Number(row.id), code: row.inbound_code, account: row.account_name,
                status: row.status, reference: row.reference_number, expectedDate: row.expected_date,
                currentWarehouseCode: row.current_warehouse_code,
                receivedAt: row.received_at
            },
            meadowpine: warehouse.rows[0],
            lines: lines.rows,
            documents: documents.rows,
            palletLabels: palletLabels.rows,
            receiptAllocations: receiptAllocations.rows,
            ledger: ledger.rows,
            customerRecipientCount: Number(recipients.rows[0].recipient_count),
            requiredAddressing: { visibleTo: "support@wms365.co", ccCount: 0, customerRecipientsInBcc: true },
            priorEmails: priorEmails.rows.map((email) => ({
                status: email.status, toCount: email.to_addresses.length, ccCount: email.cc_addresses.length,
                bccCount: email.bcc_addresses.length, messageIdPresent: Boolean(email.message_id), sentAt: email.sent_at
            }))
        }));
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
