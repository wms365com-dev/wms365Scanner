const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const CODE = 'INB-000205';
const ACCOUNT = 'SPECTRUM DYES & PIGMENTS INC.';
const ACCOUNT_ID = '3918';
const OLD_DATE = '2026-10-06';
const NEW_DATE = '2026-10-13';
const EXPECTED = new Map([
  ['SPECTRUM RED 185 SDB', { quantity: 10, lot: '260612' }],
  ['SPECTRUM YELLOW 83', { quantity: 8, lot: '26330004' }],
]);

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl: { rejectUnauthorized: false } });
  await db.connect();
  let committed = false;
  try {
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`${CODE}-RECEIPT-DATE`]);
    const account = await db.query('select id,is_active from owner_accounts where name=$1', [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error('Spectrum account identity mismatch.');
    }
    const inbound = await db.query(`select id,status,account_name,fulfillment_location_id,
      to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date
      from portal_inbounds where inbound_code=$1 for update`, [CODE]);
    if (inbound.rowCount !== 1 || inbound.rows[0].account_name !== ACCOUNT
        || Number(inbound.rows[0].fulfillment_location_id) !== 1
        || inbound.rows[0].status !== 'PUTAWAY_COMPLETE') throw new Error('Inbound identity or status changed.');
    const row = inbound.rows[0];
    const lines = await db.query(`select sku,received_quantity,received_location,lot_number
      from portal_inbound_lines where inbound_id=$1 order by line_number for update`, [row.id]);
    if (lines.rowCount !== EXPECTED.size || lines.rows.some((line) => {
      const wanted = EXPECTED.get(line.sku);
      return !wanted || Number(line.received_quantity) !== wanted.quantity || line.lot_number !== wanted.lot
        || line.received_location !== 'GW3PL-MISS-SPECTRUM-BULK';
    })) throw new Error('Received quantities, lots, or location changed.');
    const ledger = await db.query(`select id,sku,lot_number,quantity_delta,server_timestamp from inventory_transactions
      where account_name=$1 and source_type='PORTAL_INBOUND' and source_id=$2::text
        and transaction_type='RECEIVING' order by id for update`, [ACCOUNT, String(row.id)]);
    if (ledger.rowCount !== EXPECTED.size || ledger.rows.some((entry) => {
      const wanted = EXPECTED.get(entry.sku);
      return !wanted || Number(entry.quantity_delta) !== wanted.quantity || entry.lot_number !== wanted.lot;
    })) throw new Error('Inbound receiving ledger no longer matches the verified receipt.');
    if (row.receipt_date === NEW_DATE) {
      await db.query('rollback');
      return console.log(JSON.stringify({ outcome: 'already_correct', applied: false, inbound: CODE, receiptDate: NEW_DATE }));
    }
    if (row.receipt_date !== OLD_DATE) throw new Error(`Expected current receipt date ${OLD_DATE}; found ${row.receipt_date}.`);
    await db.query(`update portal_inbounds set
      arrived_at=($2::date + time '12:00') at time zone 'America/Toronto',
      received_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now() where id=$1`,
      [row.id, NEW_DATE]);
    const billing = await db.query(`update billing_events set service_date=$3::date,updated_at=now()
      where account_name=$1 and source_type='INBOUND_RECEIPT' and source_ref=$2 and status<>'VOID'
      returning id,event_key,service_date`, [ACCOUNT, CODE, NEW_DATE]);
    const verify = await db.query(`select status,to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date
      from portal_inbounds where id=$1`, [row.id]);
    const ledgerVerify = await db.query(`select count(*)::integer count,sum(quantity_delta)::integer quantity
      from inventory_transactions where account_name=$1 and source_type='PORTAL_INBOUND'
        and source_id=$2::text and transaction_type='RECEIVING'`, [ACCOUNT, String(row.id)]);
    const check = ledgerVerify.rows[0];
    if (verify.rows[0].receipt_date !== NEW_DATE || Number(check.count) !== 2 || Number(check.quantity) !== 18
        || billing.rows.some((event) => String(event.service_date).slice(0, 10) !== NEW_DATE)) {
      throw new Error('Receipt-date correction verification failed.');
    }
    const result = { outcome: APPLY ? 'receipt_date_corrected' : 'dry_run_rolled_back', applied: APPLY,
      inbound: CODE, previousReceiptDate: OLD_DATE, receiptDate: NEW_DATE, stockQuantityChanged: false,
      receivingLedgerQuantity: 18, billingEventsUpdated: billing.rowCount };
    if (APPLY) { await db.query('commit'); committed = true; } else await db.query('rollback');
    console.log(JSON.stringify(result));
  } catch (error) { if (!committed) await db.query('rollback').catch(() => {}); throw error; }
  finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
