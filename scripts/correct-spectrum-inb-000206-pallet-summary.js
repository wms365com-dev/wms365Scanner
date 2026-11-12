const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');
const CODES = ['GW130726-P01','GW130726-P02','GW130726-P03','GW130726-P04'];

async function main(){
  const db=new Client({connectionString:process.env.DATABASE_URL||process.env.DATABASE_PRIVATE_URL,ssl:{rejectUnauthorized:false}});
  await db.connect(); let committed=false;
  try{
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['INB-000206-PALLET-SUMMARY']);
    const result=await db.query(`select i.id inbound_id,i.status,i.account_name,l.id line_id,l.sku,l.received_quantity,
      l.pallet_count,l.pallet_codes from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
      where i.inbound_code='INB-000206' for update of i,l`);
    if(result.rowCount!==1)throw new Error('INB-000206 was not found uniquely.');
    const row=result.rows[0];
    if(row.account_name!=='SPECTRUM DYES & PIGMENTS INC.'||row.status!=='PUTAWAY_COMPLETE'
      ||row.sku!=='SPECTRUM BLUE 15:4 CCS'||Number(row.received_quantity)!==100)throw new Error('Inbound receipt identity changed.');
    const labels=await db.query(`select pl.pallet_code,pl.pallet_status,pl.actual_quantity,plc.quantity,plc.lot_number
      from portal_inbound_pallet_labels pl join portal_inbound_pallet_label_contents plc on plc.pallet_label_id=pl.id
      where pl.inbound_id=$1 order by pl.pallet_code for update of pl,plc`,[row.inbound_id]);
    if(labels.rowCount!==4||labels.rows.some((label,index)=>label.pallet_code!==CODES[index]
      ||label.pallet_status!=='RECEIVED'||Number(label.actual_quantity)!==25||Number(label.quantity)!==25
      ||label.lot_number!=='CC-26-8197-26'))throw new Error('Verified pallet records do not match the packing slip.');
    await db.query(`update portal_inbound_lines set pallet_count=4,pallet_codes=$2,updated_at=now() where id=$1`,
      [row.line_id,CODES.join(', ')]);
    const verify=await db.query('select pallet_count,pallet_codes from portal_inbound_lines where id=$1',[row.line_id]);
    if(Number(verify.rows[0].pallet_count)!==4||verify.rows[0].pallet_codes!==CODES.join(', '))throw new Error('Pallet summary verification failed.');
    const output={outcome:APPLY?'pallet_summary_corrected':'dry_run_rolled_back',applied:APPLY,inbound:'INB-000206',palletCount:4,stockQuantityChanged:false};
    if(APPLY){await db.query('commit');committed=true;}else await db.query('rollback');
    console.log(JSON.stringify(output));
  }catch(error){if(!committed)await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
