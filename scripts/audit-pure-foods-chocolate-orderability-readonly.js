const { Client } = require('pg');
const { getPortalInventorySummary } = require('../server');

const ACCOUNT = 'PURE FOODS BY ESTEE';
const ACCOUNT_ID = '1544';
const WAREHOUSE_ID = 1;
const SKUS = ['CHD-CU-6049701-019','CHD-DR-6000314-036'];
const EXPECTED_BINS = ['CJ02AB','CJ04AA','CJ04AB','CJ06AA','CJ06AB','CJ08AA','CJ10AA','CJ12AA','CJ14AA','CJ16AA'];

async function main(){
  const db=new Client({connectionString:process.env.DATABASE_URL||process.env.DATABASE_PRIVATE_URL,ssl:{rejectUnauthorized:false}});
  await db.connect();
  try{
    await db.query('begin read only');
    const account=await db.query('select id,name,is_active from owner_accounts where name=$1',[ACCOUNT]);
    const catalog=await db.query(`select sku,description,tracking_level,uom_label,unit_uom,units_per_case,
      item_type,item_category,blocked,lot_tracked,expiration_tracked from item_catalog
      where account_name=$1 and sku=any($2::text[]) order by sku`,[ACCOUNT,SKUS]);
    const stock=await db.query(`select i.location,i.sku,i.lot_number,i.expiration_date,i.quantity,
      b.account_name bin_account,b.fulfillment_location_id,b.location_type,b.is_pickable
      from inventory_lines i left join bin_locations b on b.code=i.location
      where i.account_name=$1 and (i.sku=any($2::text[]) or i.location=any($3::text[]))
      order by i.sku,i.location,i.lot_number`,[ACCOUNT,SKUS,EXPECTED_BINS]);
    const allocations=await db.query(`select o.order_code,o.status,a.sku,a.allocated_quantity,a.location
      from portal_order_allocations a join portal_orders o on o.id=a.order_id
      where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED') and a.sku=any($2::text[])
      order by a.sku,o.order_code`,[ACCOUNT,SKUS]);
    const portal=await getPortalInventorySummary(ACCOUNT,db,{fulfillmentLocationId:WAREHOUSE_ID});
    const portalItems=portal.filter(item=>SKUS.includes(item.sku));
    const matchingNames=portal.filter(item=>/SEMI-SWEET CHOCOLATE|6049701|6000314/i.test(`${item.sku} ${item.description}`));
    await db.query('rollback');
    const physicalBins=await db.query(`select b.code,b.account_name,b.fulfillment_location_id,b.location_type,b.is_pickable,
      i.account_name inventory_account,i.sku,i.lot_number,i.expiration_date,i.quantity
      from bin_locations b left join inventory_lines i on i.location=b.code
      where b.code=any($1::text[]) order by b.code,i.account_name,i.sku`,[EXPECTED_BINS]);
    const codeMatches=await db.query(`select i.account_name,i.location,i.sku,c.description,i.lot_number,i.expiration_date,i.quantity
      from inventory_lines i left join item_catalog c on c.account_name=i.account_name and c.sku=i.sku
      where i.sku ilike any($1::text[]) or c.description ilike any($1::text[])
      order by i.account_name,i.sku,i.location`,[['%6049701%','%6000314%','%SEMI-SWEET CHOCOLATE%']]);
    console.log(JSON.stringify({account:account.rows,catalog:catalog.rows,stock:stock.rows,allocations:allocations.rows,
      portalItems,matchingPortalItems:matchingNames,physicalBins:physicalBins.rows,codeMatches:codeMatches.rows,
      missingExpectedBins:EXPECTED_BINS.filter(code=>!stock.rows.some(row=>row.location===code))}));
  }catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
