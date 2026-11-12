const { Client } = require('pg');
const { APP_USER_ROLES, upsertInventoryLine, getPortalInventorySummary } = require('../server');

const APPLY=process.argv.includes('--apply');
const ACCOUNT='PURE FOODS BY ESTEE';
const ACCOUNT_ID='1';
const WAREHOUSE_ID=1;
const WAREHOUSE_CODE='GW3PL-MISS';
const SOURCE_ID='PURE-FOODS-CHOCOLATE-PHYSICAL-STOCK-20261021';
const ACTOR={id:null,email:'operations@wms365.co',full_name:'WMS365 Owner-Approved Physical Stock',role:APP_USER_ROLES.SUPER_ADMIN};
const STOCK=[
  {location:'GW3PL-MISS-CJ02AB',physicalLocation:'CJ02AB',sku:'CHD-CU-6049701-019',quantity:40},
  {location:'GW3PL-MISS-CJ04AA',physicalLocation:'CJ04AA',sku:'CHD-CU-6049701-019',quantity:49},
  {location:'GW3PL-MISS-CJ04AB',physicalLocation:'CJ04AB',sku:'CHD-CU-6049701-019',quantity:40},
  {location:'GW3PL-MISS-CJ06AA',physicalLocation:'CJ06AA',sku:'CHD-CU-6049701-019',quantity:40},
  {location:'GW3PL-MISS-CJ08AA',physicalLocation:'CJ08AA',sku:'CHD-CU-6049701-019',quantity:40},
  {location:'GW3PL-MISS-CJ06AB',physicalLocation:'CJ06AB',sku:'CHD-DR-6000314-036',quantity:50},
  {location:'GW3PL-MISS-CJ10AA',physicalLocation:'CJ10AA',sku:'CHD-DR-6000314-036',quantity:70},
  {location:'GW3PL-MISS-CJ12AA',physicalLocation:'CJ12AA',sku:'CHD-DR-6000314-036',quantity:70},
  {location:'GW3PL-MISS-CJ14AA',physicalLocation:'CJ14AA',sku:'CHD-DR-6000314-036',quantity:70},
  {location:'GW3PL-MISS-CJ16AA',physicalLocation:'CJ16AA',sku:'CHD-DR-6000314-036',quantity:70},
];
const TOTALS=new Map([['CHD-CU-6049701-019',209],['CHD-DR-6000314-036',330]]);

async function main(){
  const db=new Client({connectionString:process.env.DATABASE_URL||process.env.DATABASE_PRIVATE_URL,ssl:{rejectUnauthorized:false}});
  await db.connect();let committed=false;
  try{
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))',[SOURCE_ID]);
    const account=await db.query('select id,is_active from owner_accounts where name=$1',[ACCOUNT]);
    if(account.rowCount!==1||String(account.rows[0].id)!==ACCOUNT_ID||!account.rows[0].is_active)throw new Error('Pure Foods account identity mismatch.');
    const warehouse=await db.query(`select fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
      from fulfillment_locations fl join company_fulfillment_locations cfl on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
      where fl.id=$2`,[ACCOUNT,WAREHOUSE_ID]);
    if(warehouse.rowCount!==1||warehouse.rows[0].code!==WAREHOUSE_CODE||!warehouse.rows[0].is_active
      ||!warehouse.rows[0].allow_outbound||!warehouse.rows[0].allow_storage||!warehouse.rows[0].customer_portal_visible)throw new Error('Pure Foods portal warehouse assignment mismatch.');
    const items=await db.query(`select sku,description,upc,blocked,item_type from item_catalog
      where account_name=$1 and sku=any($2::text[]) order by sku for update`,[ACCOUNT,[...TOTALS.keys()]]);
    if(items.rowCount!==2||items.rows.some(item=>item.blocked||item.item_type!=='INVENTORY'))throw new Error('Pure Foods item identity or eligibility changed.');
    const codes=STOCK.map(row=>row.location);
    const foreignBins=await db.query(`select code,account_name,fulfillment_location_id from bin_locations where code=any($1::text[]) for update`,[codes]);
    if(foreignBins.rows.some(bin=>(bin.account_name&&bin.account_name!==ACCOUNT)
      ||(bin.fulfillment_location_id&&Number(bin.fulfillment_location_id)!==WAREHOUSE_ID)))throw new Error('One or more physical bins belongs to another tenant or warehouse.');
    const existing=await db.query(`select account_name,location,sku,lot_number,expiration_date,quantity from inventory_lines
      where location=any($1::text[]) or (account_name=$2 and sku=any($3::text[])) for update`,[codes,ACCOUNT,[...TOTALS.keys()]]);
    const prior=await db.query(`select idempotency_key,location,sku,quantity_delta,quantity_after from inventory_transactions
      where source_type='OWNER_APPROVED_PHYSICAL_STOCK' and source_id=$1 order by location`,[SOURCE_ID]);
    if(prior.rowCount){
      if(prior.rowCount!==STOCK.length||existing.rows.length!==STOCK.length
        ||STOCK.some(spec=>!existing.rows.some(row=>row.account_name===ACCOUNT&&row.location===spec.location&&row.sku===spec.sku&&Number(row.quantity)===spec.quantity)))throw new Error('Existing physical-stock setup is incomplete or conflicting.');
      await db.query('rollback');
      return console.log(JSON.stringify({outcome:'already_available',applied:false,account:ACCOUNT,totals:Object.fromEntries(TOTALS)}));
    }
    if(existing.rowCount)throw new Error('Existing stock overlaps the requested bins or SKUs; manual reconciliation required.');
    await db.query(`update item_catalog set tracking_level='CASE',uom_label='cases',unit_uom='CASE',units_per_case=1,
      blocked=false,updated_at=now() where account_name=$1 and sku=any($2::text[])`,[ACCOUNT,[...TOTALS.keys()]]);
    for(const spec of STOCK){
      await db.query(`insert into bin_locations(code,note,location_type,is_pickable,account_name,fulfillment_location_id)
        values($1,$2,'STORAGE',true,$3,$4)
        on conflict(code) do update set note=excluded.note,location_type='STORAGE',is_pickable=true,
          account_name=excluded.account_name,fulfillment_location_id=excluded.fulfillment_location_id,updated_at=now()`,
        [spec.location,`Pure Foods case storage; physical location ${spec.physicalLocation}; owner-confirmed stock.`,ACCOUNT,WAREHOUSE_ID]);
      const item=items.rows.find(entry=>entry.sku===spec.sku);
      await upsertInventoryLine(db,{accountName:ACCOUNT,location:spec.location,sku:spec.sku,upc:item.upc||'',
        lotNumber:'',expirationDate:'',trackingLevel:'CASE',quantity:spec.quantity},{transactionType:'ADJUSTMENT',
        sourceType:'OWNER_APPROVED_PHYSICAL_STOCK',sourceId:SOURCE_ID,fulfillmentLocationId:WAREHOUSE_ID,
        appUser:ACTOR,idempotencyKey:`${SOURCE_ID}:${spec.location}:${spec.sku}`,source:'web_admin'});
    }
    await db.query(`insert into activity_log(type,title,details) values('inventory',$1,$2)`,[
      'Made owner-confirmed Pure Foods chocolate stock orderable',
      `${ACCOUNT} | ${WAREHOUSE_CODE} | 10 physical bins | CHD-CU-6049701-019 209 cases | CHD-DR-6000314-036 330 cases`
    ]);
    const [saved,ledger]=await Promise.all([
      db.query(`select i.location,i.sku,i.quantity,i.tracking_level,b.account_name,b.fulfillment_location_id,b.location_type,b.is_pickable
        from inventory_lines i join bin_locations b on b.code=i.location
        where i.account_name=$1 and i.location=any($2::text[]) order by i.location`,[ACCOUNT,codes]),
      db.query(`select location,sku,quantity_delta,quantity_before,quantity_after,idempotency_key from inventory_transactions
        where source_type='OWNER_APPROVED_PHYSICAL_STOCK' and source_id=$1 order by location`,[SOURCE_ID])
    ]);
    const portal=await getPortalInventorySummary(ACCOUNT,db,{fulfillmentLocationId:WAREHOUSE_ID});
    const portalItems=portal.filter(item=>TOTALS.has(item.sku));
    if(saved.rowCount!==STOCK.length||ledger.rowCount!==STOCK.length||portalItems.length!==2
      ||STOCK.some(spec=>!saved.rows.some(row=>row.location===spec.location&&row.sku===spec.sku
        &&Number(row.quantity)===spec.quantity&&row.tracking_level==='CASE'&&row.account_name===ACCOUNT
        &&Number(row.fulfillment_location_id)===WAREHOUSE_ID&&row.location_type==='STORAGE'&&row.is_pickable))
      ||[...TOTALS].some(([sku,total])=>{const item=portalItems.find(entry=>entry.sku===sku);return !item||Number(item.onHandQuantity)!==total||Number(item.availableQuantity)!==total;}))throw new Error('Post-setup portal availability verification failed.');
    const output={outcome:APPLY?'available_for_customer_orders':'dry_run_rolled_back',applied:APPLY,account:ACCOUNT,
      warehouse:WAREHOUSE_CODE,items:portalItems.map(item=>({sku:item.sku,onHand:item.onHandQuantity,reserved:item.reservedQuantity,available:item.availableQuantity})),bins:STOCK.length};
    if(APPLY){await db.query('commit');committed=true;}else await db.query('rollback');
    console.log(JSON.stringify(output));
  }catch(error){if(!committed)await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
