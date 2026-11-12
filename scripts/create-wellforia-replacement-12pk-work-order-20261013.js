const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const ACCOUNT = 'WELLFORIA HEALTH INC';
const WAREHOUSE = 'GW3PL-MISS';
const SOURCE_SKU = 'WW-12PK';
const TARGET_SKU = 'WW-12PK-EA';
const REFERENCE = 'WF-REPL-12PK-EACH-20261013';
const ORDER_REFERENCES = ['WF-CONS-20261013-001','WF-CONS-20261013-002','WF-CONS-20261013-003','WF-CONS-20261013-004','WF-CONS-20261013-005'];
const SOURCE_CASES = 1;
const PACKS_PER_CASE = 4;
const TARGET_PACKS = 4;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (!APPLY) await client.query('set transaction read only');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [REFERENCE]);
    const [account, warehouse, items, duplicate, demand, targetInventory, sourceInventory] = await Promise.all([
      client.query('select name,is_active from owner_accounts where name=$1', [ACCOUNT]),
      client.query(`select fl.id,fl.code,fl.is_active,cfl.allow_storage from company_fulfillment_locations cfl
        join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id where cfl.account_name=$1 and fl.code=$2`, [ACCOUNT, WAREHOUSE]),
      client.query(`select sku,tracking_level,units_per_case,blocked from item_catalog
        where account_name=$1 and sku=any($2::text[]) order by sku`, [ACCOUNT, [SOURCE_SKU,TARGET_SKU]]),
      client.query(`select request_code,status from portal_kitting_requests where account_name=$1 and purchase_order_reference=$2`, [ACCOUNT, REFERENCE]),
      client.query(`select count(distinct o.id)::int order_count,coalesce(sum(l.requested_quantity),0)::int requested
        from portal_orders o join portal_order_lines l on l.order_id=o.id
        where o.account_name=$1 and o.status='DRAFT' and o.po_number=any($2::text[]) and l.sku=$3`, [ACCOUNT, ORDER_REFERENCES, TARGET_SKU]),
      client.query(`select coalesce(sum(i.quantity),0)::int on_hand from inventory_lines i join bin_locations b on b.code=i.location
        join fulfillment_locations fl on fl.id=b.fulfillment_location_id
        where i.account_name=$1 and i.sku=$2 and fl.code=$3 and b.is_pickable=true`, [ACCOUNT,TARGET_SKU,WAREHOUSE]),
      client.query(`select i.id,i.location,i.quantity,i.lot_number,i.expiration_date,i.tracking_level,
        coalesce((select sum(a.allocated_quantity) from portal_order_allocations a join portal_orders o on o.id=a.order_id
          where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED')),0)::int
        +coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a join portal_kitting_requests k on k.id=a.kitting_request_id
          where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int committed
        from inventory_lines i join bin_locations b on b.code=i.location join fulfillment_locations fl on fl.id=b.fulfillment_location_id
        where i.account_name=$1 and i.sku=$2 and fl.code=$3 and b.is_pickable=true order by i.id ${APPLY ? 'for update of i' : ''}`, [ACCOUNT,SOURCE_SKU,WAREHOUSE]),
    ]);
    if (account.rowCount!==1 || account.rows[0].is_active!==true) throw new Error('Exact active Wellforia tenant verification failed.');
    if (warehouse.rowCount!==1 || warehouse.rows[0].is_active!==true || warehouse.rows[0].allow_storage!==true) throw new Error('Exact active Mississauga warehouse verification failed.');
    if (items.rowCount!==2 || items.rows.some((item)=>item.blocked)) throw new Error('Required item verification failed.');
    const sourceItem=items.rows.find((item)=>item.sku===SOURCE_SKU);
    const targetItem=items.rows.find((item)=>item.sku===TARGET_SKU);
    if (sourceItem.tracking_level!=='CASE' || Number(sourceItem.units_per_case)!==PACKS_PER_CASE) throw new Error('Source case pack is not exactly four.');
    if (targetItem.tracking_level!=='UNIT' || Number(targetItem.units_per_case)!==1) throw new Error('Target each item setup is invalid.');
    if (duplicate.rowCount) {
      await client.query('rollback');
      console.log(JSON.stringify({mode:APPLY?'APPLY':'PREFLIGHT',alreadyExists:true,request:duplicate.rows[0]}));
      return;
    }
    const requested=Number(demand.rows[0].requested),onHand=Number(targetInventory.rows[0].on_hand),shortage=Math.max(0,requested-onHand);
    const sourceAvailable=sourceInventory.rows.reduce((sum,row)=>sum+Math.max(0,Number(row.quantity)-Number(row.committed)),0);
    if (Number(demand.rows[0].order_count)!==5 || requested!==5 || shortage!==3) throw new Error(`Replacement demand changed: ${demand.rows[0].order_count} orders, ${requested} requested, ${onHand} on hand, ${shortage} short.`);
    if (sourceAvailable<SOURCE_CASES) throw new Error('No uncommitted source case is available.');
    const summary={mode:APPLY?'APPLY':'PREFLIGHT',account:ACCOUNT,warehouse:WAREHOUSE,
      demand:{orders:5,requested,onHand,shortage},source:{sku:SOURCE_SKU,cases:SOURCE_CASES,available:sourceAvailable,packsPerCase:PACKS_PER_CASE},
      target:{sku:TARGET_SKU,packs:TARGET_PACKS,excessAfterDemand:1},reference:REFERENCE};
    if (!APPLY) { await client.query('rollback'); console.log(JSON.stringify(summary)); return; }
    const inserted=await client.query(`insert into portal_kitting_requests(account_name,portal_access_id,status,
      sales_order_reference,purchase_order_reference,source_sku,source_quantity,components_json,target_sku,target_quantity,
      requested_completion_date,requested_by_name,requested_by_email,notes,fulfillment_location_id,
      processing_business_days,earliest_completion_date,holiday_closures_json)
      values($1,null,'SUBMITTED',$2,$3,$4,$5,$6::jsonb,$7,$8,current_date,$9,'',$10,$11,1,current_date,'[]'::jsonb) returning id`,
    [ACCOUNT,'S-ORD101224 through S-ORD101228 replacement batch',REFERENCE,SOURCE_SKU,SOURCE_CASES,
      JSON.stringify([{sku:SOURCE_SKU,totalQuantity:SOURCE_CASES,quantityPerUnit:PACKS_PER_CASE,description:'Whoopsie Wipes 12 Pack master case'}]),
      TARGET_SKU,TARGET_PACKS,'Warehouse operations',`Break 1 full ${SOURCE_SKU} master case at 4 consumer packs per case. Receive 4 individually pickable ${TARGET_SKU}; 3 cover the verified replacement-order shortage and 1 remains available.`,warehouse.rows[0].id]);
    const id=inserted.rows[0].id,requestCode=`KIT-${String(id).padStart(6,'0')}`;
    await client.query('update portal_kitting_requests set request_code=$2,updated_at=now() where id=$1',[id,requestCode]);
    const sourceLine=sourceInventory.rows.find((row)=>Number(row.quantity)-Number(row.committed)>=1);
    await client.query(`insert into portal_kitting_allocations(kitting_request_id,inventory_line_id,sku,location,
      lot_number,expiration_date,tracking_level,allocated_quantity) values($1,$2,$3,$4,$5,$6,$7,1)`,
    [id,sourceLine.id,SOURCE_SKU,sourceLine.location,sourceLine.lot_number||'',sourceLine.expiration_date||'',sourceLine.tracking_level]);
    await client.query(`insert into activity_log(type,title,details) values('kitting',$1,$2)`,
    [`Submitted kitting request ${requestCode}`,`${ACCOUNT} | 1 ${SOURCE_SKU} case -> 4 ${TARGET_SKU} eaches | ${REFERENCE}`]);
    await client.query('commit');
    const verified=await pool.query(`select k.request_code,k.status,k.source_sku,k.source_quantity,k.target_sku,k.target_quantity,
      coalesce(sum(a.allocated_quantity),0)::int allocated from portal_kitting_requests k
      left join portal_kitting_allocations a on a.kitting_request_id=k.id where k.id=$1 group by k.id`,[id]);
    const row=verified.rows[0];
    if (!row || row.status!=='SUBMITTED' || Number(row.source_quantity)!==1 || Number(row.target_quantity)!==4 || Number(row.allocated)!==1) throw new Error('Post-commit work-order verification failed.');
    console.log(JSON.stringify({...summary,requestCode,verified:row,sideEffects:{inventoryMoved:0,ordersReleased:0,emailed:0,printed:0}}));
  } catch(error) { await client.query('rollback').catch(()=>{}); throw error; }
  finally { client.release(); await pool.end(); }
}

main().catch((error)=>{console.error(error.stack||error.message);process.exitCode=1;});
