const { Client } = require('pg');
const zlib = require('node:zlib');

const INBOUND = 'INB-000209';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const inboundResult = await db.query(`select i.id,i.inbound_code,i.account_name,i.status,
      i.reference_number,i.created_at,i.received_at,fl.code warehouse_code,fl.name warehouse_name
      from portal_inbounds i left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
      where i.inbound_code=$1`, [INBOUND]);
    if (inboundResult.rowCount !== 1) throw new Error(`Expected exactly one ${INBOUND}; found ${inboundResult.rowCount}`);
    const inbound = inboundResult.rows[0];
    const documents = (await db.query(`select id,file_name,file_type,file_size,document_category,
      uploaded_by,created_at,encode(file_data,'base64') file_base64
      from portal_inbound_documents where inbound_id=$1 order by created_at,id`, [inbound.id])).rows;
    await db.query('ROLLBACK');
    const result = { generatedAt: new Date().toISOString(), inbound, documents };
    process.stdout.write('DATA:' + zlib.gzipSync(Buffer.from(JSON.stringify(result))).toString('base64') + '\n');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
