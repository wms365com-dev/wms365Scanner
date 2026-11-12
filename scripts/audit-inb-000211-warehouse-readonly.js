const { Client } = require("pg");

const CODE = "INB-000211";

async function main() {
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await db.connect();
    try {
        await db.query("begin read only");
        const inboundResult = await db.query(
            `select i.*, fl.code warehouse_code, fl.name warehouse_name
             from portal_inbounds i
             left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
             where i.inbound_code=$1`,
            [CODE]
        );
        if (inboundResult.rowCount !== 1) throw new Error(`${CODE}: expected exactly one inbound.`);
        const inbound = inboundResult.rows[0];
        const lines = await db.query(
            `select * from portal_inbound_lines where inbound_id=$1 order by line_number`,
            [inbound.id]
        );
        const allocations = await db.query(
            `select * from portal_inbound_receipt_allocations where inbound_id=$1 order by allocation_number`,
            [inbound.id]
        );
        const ledger = await db.query(
            `select * from inventory_transactions
             where source_type='PORTAL_INBOUND' and source_id=$1::text order by id`,
            [String(inbound.id)]
        );
        const warehouses = await db.query(
            `select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,
                    cfl.allow_storage,cfl.customer_portal_visible,cfl.is_primary
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 order by fl.id`,
            [inbound.account_name]
        );
        const item = await db.query(
            `select sku,tracking_level,unit_uom,lot_tracked,expiration_tracked,blocked
             from item_catalog where account_name=$1 and sku=$2`,
            [inbound.account_name, lines.rows[0]?.sku || ""]
        );
        const bins = await db.query(
            `select code,location_type,is_pickable,account_name,fulfillment_location_id
             from bin_locations
             where account_name=$1 and fulfillment_location_id=$2
               and is_pickable=true
               and location_type in ('STORAGE','BULK','PICK')
             order by code`,
            [inbound.account_name, inbound.fulfillment_location_id]
        );
        const documents = await db.query(
            `select id,file_name,file_type,file_size,document_category,created_at
             from portal_inbound_documents where inbound_id=$1 order by id`,
            [inbound.id]
        );
        await db.query("rollback");
        console.log(JSON.stringify({
            inbound: {
                id: inbound.id,
                inboundCode: inbound.inbound_code,
                accountName: inbound.account_name,
                status: inbound.status,
                warehouseId: inbound.fulfillment_location_id,
                warehouseCode: inbound.warehouse_code,
                warehouseName: inbound.warehouse_name,
                referenceNumber: inbound.reference_number,
                containerNumber: inbound.container_number,
                expectedDate: inbound.expected_date,
                notes: inbound.notes,
                receivedAt: inbound.received_at,
                completedAt: inbound.completed_at
            },
            lines: lines.rows,
            allocations: allocations.rows,
            ledger: ledger.rows,
            item: item.rows,
            pickableBins: bins.rows,
            documents: documents.rows,
            warehouseAssignments: warehouses.rows
        }));
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
