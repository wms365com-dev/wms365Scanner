const crypto = require('node:crypto');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const API_ORIGIN = 'https://app.wms365.co';
const ACCOUNT = 'WELLFORIA HEALTH INC';
const WAREHOUSE_ID = '1';
const PORTAL_USER_EMAIL = 'usman.tahir@wellforia.com';
const EXPECTED = new Map([
  ['S-ORD101224', [{ sku: 'WW-12PK-EA', quantity: 1 }]],
  ['S-ORD101225', [{ sku: 'WW-12PK-EA', quantity: 1 }]],
  ['S-ORD101226', [{ sku: 'WW-12PK-EA', quantity: 1 }]],
  ['S-ORD101227', [{ sku: 'WW-12PK-EA', quantity: 1 }, { sku: 'WW-6PK-EA', quantity: 1 }]],
  ['S-ORD101228', [{ sku: 'WW-12PK-EA', quantity: 1 }]],
]);

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function createSession(pool, accessId) {
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(`insert into portal_sessions(portal_access_id,token_hash,expires_at)
    values($1,$2,now()+interval '15 minutes') returning id`, [accessId, hashToken(token)]);
  return { id: result.rows[0].id, token };
}

async function callRelease(orderId, token) {
  const response = await fetch(`${API_ORIGIN}/api/portal/orders/${orderId}/release`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      Cookie: `wms365_portal_session=${encodeURIComponent(token)}` },
    body: JSON.stringify({ notifyWarehouse: true, shippingLabelAttached: false, ccEmails: [],
      rushApproved: false, rushExempt: false, splitFulfillmentApproved: false }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) throw new Error(`${response.status}: ${payload.error || payload.message || 'release failed'}`);
  return payload;
}

async function loadOrders(pool) {
  const result = await pool.query(`select o.id,o.order_code,o.status,o.account_name,o.portal_access_id,
    o.fulfillment_location_id,p.email portal_user_email,p.is_active portal_user_active,
    l.id line_id,l.line_number,l.sku,l.requested_quantity
    from portal_orders o join portal_order_lines l on l.order_id=o.id
    left join portal_vendor_access p on p.id=o.portal_access_id
    where o.account_name=$1 and o.order_code=any($2::text[]) order by o.order_code,l.line_number,l.id`,
  [ACCOUNT,[...EXPECTED.keys()]]);
  const grouped=new Map();
  for(const row of result.rows){
    if(!grouped.has(row.order_code)) grouped.set(row.order_code,{...row,lines:[]});
    grouped.get(row.order_code).lines.push({id:row.line_id,sku:row.sku,quantity:Number(row.requested_quantity)});
  }
  return grouped;
}

async function verifyReleased(pool, orderId) {
  return (await pool.query(`select o.status,l.line_number,l.sku,l.requested_quantity,
    coalesce(sum(a.allocated_quantity),0)::int allocated_quantity
    from portal_orders o join portal_order_lines l on l.order_id=o.id
    left join portal_order_allocations a on a.order_line_id=l.id
    where o.id=$1 group by o.status,l.id,l.line_number,l.sku,l.requested_quantity order by l.line_number`,[orderId])).rows;
}

async function main(){
  const pool=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL,ssl:false});
  const sessions=[];
  try{
    const orders=await loadOrders(pool);
    const portalResult=await pool.query(`select id,email,is_active from portal_vendor_access
      where account_name=$1 and lower(email)=lower($2)`,[ACCOUNT,PORTAL_USER_EMAIL]);
    if(portalResult.rowCount!==1||portalResult.rows[0].is_active!==true) throw new Error('Exact active Wellforia portal owner could not be verified.');
    const portalUser=portalResult.rows[0];
    const missing=[...EXPECTED.keys()].filter((code)=>!orders.has(code));
    if(missing.length) throw new Error(`Missing Wellforia orders: ${missing.join(', ')}`);
    const demand={}; const preflight=[];
    for(const [code,expectedLines] of EXPECTED){
      const order=orders.get(code);
      if(order.portal_access_id&&String(order.portal_access_id)!==String(portalUser.id)) throw new Error(`${code} belongs to a different portal user.`);
      if(String(order.fulfillment_location_id)!==WAREHOUSE_ID) throw new Error(`${code} is not assigned to GW3PL-MISS.`);
      if(!['DRAFT','RELEASED'].includes(order.status)) throw new Error(`${code} is ${order.status}, not releasable.`);
      if(JSON.stringify(order.lines.map(({sku,quantity})=>({sku,quantity})))!==JSON.stringify(expectedLines)) throw new Error(`${code} lines changed.`);
      for(const line of expectedLines) demand[line.sku]=(demand[line.sku]||0)+line.quantity;
      preflight.push({code,status:order.status,lines:expectedLines});
    }
    const availability={};
    for(const [sku,total] of Object.entries(demand)){
      const result=await pool.query(`select coalesce(sum(i.quantity),0)::int-coalesce((select sum(a.allocated_quantity)::int
        from portal_order_allocations a join portal_order_lines l on l.id=a.order_line_id join portal_orders o on o.id=l.order_id
        where o.account_name=$1 and o.status in ('RELEASED','PICKED','STAGED') and l.sku=$2),0)::int available
        from inventory_lines i join bin_locations b on b.code=i.location where i.account_name=$1 and i.sku=$2
        and b.fulfillment_location_id=$3 and b.is_pickable=true`,[ACCOUNT,sku,WAREHOUSE_ID]);
      availability[sku]=Number(result.rows[0].available);
      const draftDemand=preflight.filter((row)=>row.status==='DRAFT').flatMap((row)=>row.lines).filter((line)=>line.sku===sku).reduce((sum,line)=>sum+line.quantity,0);
      if(availability[sku]<draftDemand) throw new Error(`Only ${availability[sku]} ${sku} units are available for ${draftDemand} draft demand.`);
    }
    if(!APPLY){console.log(JSON.stringify({mode:'PREFLIGHT',account:ACCOUNT,portalOwner:portalUser.email,orderCount:5,demand,availability,orders:preflight}));return;}
    const ownership=await pool.query(`update portal_orders set portal_access_id=$3,updated_at=now()
      where account_name=$1 and order_code=any($2::text[]) and portal_access_id is null returning order_code`,[ACCOUNT,[...EXPECTED.keys()],portalUser.id]);
    if(ownership.rowCount) await pool.query(`insert into activity_log(type,title,details) values('order',$1,$2)`,
      ['Assigned Wellforia replacement-order ownership',`${ownership.rowCount} replacement orders assigned to the verified Wellforia portal account before release.`]);
    const results=[];
    for(const [code,expectedLines] of EXPECTED){
      const order=orders.get(code);
      if(order.status==='DRAFT'){
        const session=await createSession(pool,portalUser.id);sessions.push(session.id);
        const response=await callRelease(order.id,session.token);
        results.push({code,released:true,releaseActions:response.releaseActions||null});
      } else results.push({code,released:false,alreadyReleased:true});
      const lines=await verifyReleased(pool,order.id);
      if(lines.length!==expectedLines.length||lines.some((line,index)=>line.status!=='RELEASED'||line.sku!==expectedLines[index].sku
        ||Number(line.requested_quantity)!==expectedLines[index].quantity||Number(line.allocated_quantity)!==expectedLines[index].quantity))
        throw new Error(`${code} did not reconcile as fully released and allocated.`);
      results[results.length-1].verification=lines;
    }
    const final=await pool.query(`select o.status,count(distinct o.id)::int order_count,count(l.id)::int line_count,
      coalesce(sum(l.requested_quantity),0)::int quantity from portal_orders o join portal_order_lines l on l.order_id=o.id
      where o.account_name=$1 and o.order_code=any($2::text[]) group by o.status`,[ACCOUNT,[...EXPECTED.keys()]]);
    if(final.rowCount!==1||final.rows[0].status!=='RELEASED'||Number(final.rows[0].order_count)!==5||Number(final.rows[0].line_count)!==6||Number(final.rows[0].quantity)!==6)
      throw new Error('Final replacement batch verification failed.');
    console.log(JSON.stringify({mode:'APPLIED',final:final.rows[0],availabilityBefore:availability,results}));
  }finally{
    for(const id of sessions) await pool.query('delete from portal_sessions where id=$1',[id]).catch(()=>{});
    await pool.end();
  }
}

main().catch((error)=>{console.error(error.stack||error.message);process.exit(1);});
