const { Client } = require('pg');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query('begin read only');
    const inbound = await db.query(`select i.*,fl.code warehouse_code,fl.name warehouse_name
      from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
      where i.inbound_code='INB-000215'`);
    if (inbound.rowCount !== 1) throw new Error(`Expected one inbound; found ${inbound.rowCount}`);
    const id = inbound.rows[0].id;
    const [lines,docs,allocations,labels,assignments] = await Promise.all([
      db.query('select * from portal_inbound_lines where inbound_id=$1 order by line_number', [id]),
      db.query(`select id,file_name,file_type,file_size,document_category,uploaded_by,created_at
        from portal_inbound_documents where inbound_id=$1 order by id`, [id]),
      db.query('select * from portal_inbound_receipt_allocations where inbound_id=$1 order by allocation_number', [id]),
      db.query('select * from portal_inbound_pallet_labels where inbound_id=$1 order by id', [id]),
      db.query(`select fl.id,fl.code,fl.name,cfl.allow_inbound,cfl.allow_storage,cfl.is_primary
        from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
        where cfl.account_name=$1 order by fl.id`, [inbound.rows[0].account_name]),
    ]);
    await db.query('rollback');
    console.log(JSON.stringify({ inbound: inbound.rows[0], lines: lines.rows, documents: docs.rows,
      receiptAllocations: allocations.rows, palletLabels: labels.rows, warehouseAssignments: assignments.rows }));
  } finally { await db.end(); }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
