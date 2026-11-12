const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const CODE = process.env.INBOUND_CODE || 'INB-000205';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query('begin read only');
    const result = await db.query(`select d.file_name,d.file_type,d.file_size,d.file_data
      from portal_inbound_documents d join portal_inbounds i on i.id=d.inbound_id
      where i.inbound_code=$1 and i.account_name=$2 and d.document_category='SHIPMENT_PACKING_SLIP'`,
      [CODE, 'SPECTRUM DYES & PIGMENTS INC.']);
    if (result.rowCount !== 1) throw new Error(`Expected one verified packing slip for ${CODE}.`);
    const row = result.rows[0];
    const data = Buffer.from(row.file_data);
    if (!/^GW-PS-[A-Z0-9-]+\.pdf$/i.test(row.file_name) || row.file_type !== 'application/pdf'
        || data.length !== Number(row.file_size) || !data.length) throw new Error('Packing slip identity failed verification.');
    const OUTPUT = path.resolve(__dirname, '..', 'outputs', CODE.toLowerCase(), row.file_name);
    await db.query('rollback');
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, data);
    console.log(JSON.stringify({ output: OUTPUT, bytes: data.length }));
  } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
  finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
