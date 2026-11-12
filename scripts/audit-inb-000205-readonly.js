const { Client } = require('pg');

const CODE = process.env.INBOUND_CODE || 'INB-000205';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    const inbound = await db.query(`select i.id,i.inbound_code,i.account_name,i.status,i.reference_number,i.carrier_name,
      i.expected_date::text,i.arrived_at,i.received_at,i.fulfillment_location_id,
      fl.code warehouse_code,fl.name warehouse_name,fl.is_active warehouse_active
      from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
      where i.inbound_code=$1`, [CODE]);
    if (inbound.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
    const row = inbound.rows[0];
    const lines = await db.query(`select l.id,l.line_number,l.sku,l.expected_quantity,l.received_quantity,l.received_location,
        l.lot_number,l.expiration_date::text,l.pallet_count,l.pallet_codes,
        c.description,c.upc,c.tracking_level,c.units_per_case,c.blocked,c.item_type
        from portal_inbound_lines l left join item_catalog c on c.account_name=$2 and c.sku=l.sku
        where l.inbound_id=$1 order by l.line_number`, [row.id, row.account_name]);
    const docs = await db.query(`select id,document_category,file_name,file_type,file_size,created_at
      from portal_inbound_documents where inbound_id=$1 order by id`, [row.id]);
    const movements = await db.query(`select movement_key,movement_type,from_location,to_location,sku,quantity,reason,created_at
      from inventory_movements where account_name=$1 and (movement_key ilike $2 or reason ilike $2) order by id`,
      [row.account_name, `%${CODE}%`]);
    const bins = await db.query(`select code,location_type,is_pickable from bin_locations
      where account_name=$1 and fulfillment_location_id=$2 order by code`, [row.account_name, row.fulfillment_location_id]);
    const assignment = await db.query(`select allow_inbound,allow_outbound,allow_storage from company_fulfillment_locations
      where account_name=$1 and fulfillment_location_id=$2`, [row.account_name, row.fulfillment_location_id]);
    const ledger = await db.query(`select transaction_type,sku,lot_number,sum(quantity_delta)::integer quantity
      from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text
      group by transaction_type,sku,lot_number order by sku`, [String(row.id)]);
    const inventory = await db.query(`select sku,lot_number,sum(quantity)::integer quantity
      from inventory_lines where account_name=$1 and location='GW3PL-MISS-SPECTRUM-BULK'
        and sku=any($2::text[]) group by sku,lot_number order by sku,lot_number`,
      [row.account_name, lines.rows.map((line) => line.sku)]);
    console.log(JSON.stringify({ inbound: row, lines: lines.rows, documents: docs.rows,
      movements: movements.rows, ledger: ledger.rows, inventory: inventory.rows,
      locations: bins.rows, warehouseAssignment: assignment.rows }));
  } finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
