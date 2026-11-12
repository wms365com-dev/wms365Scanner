"use strict";
const {Client}=require('pg');
const assert=require('node:assert/strict');
const ACCOUNT="RANCHER'S CHIPS";
const SHOP='f1acxk-dc.myshopify.com';
const PREORDER_SKU='RTC-SV-EA';
const PREORDER_DESCRIPTION="Rancher's Salt & Vinegar Chips - Single Bag (Preorder)";

function isPendingCanadian(order) {
    return String(order.shipping_address?.country_code||'').toUpperCase()==='CA'
        && !order.cancelled_at && !order.closed_at && order.fulfillment_status!=='fulfilled'
        && (order.line_items||[]).some(l=>l.requires_shipping!==false&&Number(l.fulfillable_quantity??l.current_quantity??l.quantity)>0);
}

function preparePreorder(order,sku=PREORDER_SKU) {
    if(!isPendingCanadian(order))throw Error('NOT_PENDING_CANADIAN');
    const lines=(order.line_items||[]).filter(l=>l.requires_shipping!==false&&Number(l.fulfillable_quantity??l.current_quantity??l.quantity)>0);
    if(!lines.length||lines.some(l=>String(l.product_id)!=='10349591724333'||String(l.variant_id)!=='52353121681709'
        ||l.title!=="PREORDER - Rancher's Salt & Vinegar"||l.variant_title!=='12 Pack'||String(l.sku||'').trim()))throw Error('UNREVIEWED_PREORDER_MAPPING');
    return {...order,line_items:lines.map(l=>({...l,sku,fulfillable_quantity:Number(l.fulfillable_quantity??l.current_quantity??l.quantity)*12}))};
}

function businessApi() {
    const fs=require('node:fs'),M=require('node:module'),path=require('node:path');
    const filename=require.resolve('../server'),m=new M(filename,module);
    m.filename=filename;m.paths=M._nodeModulePaths(path.dirname(filename));
    // Reuse the deployed catalog workflow without altering the deployed application.
    m._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.repairSaveCatalog=savePortalCatalogItemForAccount;',filename);
    return m.exports;
}

async function ensurePreorderItem(client,api,account=ACCOUNT,sku=PREORDER_SKU) {
    const found=(await client.query('select * from item_catalog where account_name=$1 and sku=$2',[account,sku])).rows;
    if(found.length){
        if(found.length!==1||found[0].description!==PREORDER_DESCRIPTION||found[0].tracking_level!=='UNIT'
            ||found[0].unit_uom!=='EA'||Number(found[0].units_per_case)!==12)throw Error('PREORDER_ITEM_CONFLICT');
        return false;
    }
    await api.repairSaveCatalog(client,account,{sku,description:PREORDER_DESCRIPTION,trackingLevel:'UNIT',unitUom:'EA',unitsPerCase:12},'',
        {activityTitlePrefix:'Shopify preorder reconciliation',activityActor:'Owner approved pending-order import'});
    return true;
}

async function savePreorder(client,api,order,account=ACCOUNT,sku=PREORDER_SKU,test=false) {
    const payload=api.mapShopifyOrderToPortalDraft(account,preparePreorder(order,sku),{store_identifier:test?'test.invalid':SHOP});
    payload.fulfillmentLocationId=1;
    payload.orderNotes+=' | SALT & VINEGAR PREORDER: no stock received; hold as DRAFT. Source 12-pack quantity converted to individual bags. Blank Shopify SKU mapped by verified product and variant IDs.';
    const saved=await api.savePortalOrderDraftForAccount(client,account,payload,null,
        {enforceInventoryAvailability:false,activityTitlePrefix:'Shopify pending preorder import',activityActor:'Owner approved reconciliation',
            ...(test?{orderCodeOverride:'TEST-RANCHERS-SV-RECONCILIATION'}:{})});
    const header=(await client.query('select account_name,status,fulfillment_location_id from portal_orders where id=$1',[saved.id])).rows[0];
    assert.equal(header.account_name,account);assert.equal(header.status,'DRAFT');assert.equal(Number(header.fulfillment_location_id),1);
    const lines=(await client.query('select sku,requested_quantity from portal_order_lines where order_id=$1 order by line_number',[saved.id])).rows;
    assert.deepEqual(lines.map(l=>({sku:l.sku,quantity:Number(l.requested_quantity)})),payload.lines);
    assert.equal((await client.query('select count(*)::int count from portal_order_allocations where order_id=$1',[saved.id])).rows[0].count,0);
    return saved;
}

async function tokenFor(row) {
    const {decryptSecret}=require('../server');
    const token=decryptSecret(row.access_token||'');
    if(token&&(!row.access_token_expires_at||new Date(row.access_token_expires_at).getTime()>Date.now()+60000))return token;
    const response=await fetch(`https://${SHOP}/admin/oauth/access_token`,{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'client_credentials',client_id:row.auth_client_id,client_secret:decryptSecret(row.auth_client_secret||'')}),
        signal:AbortSignal.timeout(30000)
    });
    const body=await response.json();
    if(!response.ok||!body.access_token)throw Error('SHOPIFY_AUTH_FAILED_'+response.status);
    return body.access_token;
}

async function fetchAll(row) {
    const token=await tokenFor(row),cutoff=new Date().toISOString();
    const scopeResponse=await fetch(`https://${SHOP}/admin/oauth/access_scopes.json`,{
        headers:{'X-Shopify-Access-Token':token},redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!scopeResponse.ok)throw Error('SHOPIFY_SCOPES_UNAVAILABLE');
    const scopes=(await scopeResponse.json()).access_scopes;
    if(!Array.isArray(scopes))throw Error('SHOPIFY_SCOPES_INVALID');
    const fullHistoryAccess=scopes.some(s=>s.handle==='read_all_orders');
    const earliest=fullHistoryAccess?null:new Date(Date.parse(cutoff)-60*86400000+60000).toISOString();
    const range=`created_at_max=${encodeURIComponent(cutoff)}`+(earliest?`&created_at_min=${encodeURIComponent(earliest)}`:'');
    async function get(url) {
        const parsed=new URL(url);
        if(parsed.origin!==`https://${SHOP}`||!parsed.pathname.startsWith('/admin/api/2026-01/')||parsed.username||parsed.password)throw Error('SHOPIFY_PAGE_SCOPE_INVALID');
        const response=await fetch(parsed,{headers:{'X-Shopify-Access-Token':token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw Error('SHOPIFY_READ_FAILED_'+response.status);
        return {body:await response.json(),link:response.headers.get('link')||''};
    }
    const storeOrderCount=(await get(`https://${SHOP}/admin/api/2026-01/orders/count.json?status=any`)).body.count;
    const storeOpenOrderCount=(await get(`https://${SHOP}/admin/api/2026-01/orders/count.json?status=open`)).body.count;
    const expected=(await get(`https://${SHOP}/admin/api/2026-01/orders/count.json?status=any&${range}`)).body.count;
    if(!Number.isInteger(expected))throw Error('SHOPIFY_COUNT_INVALID');
    console.error(JSON.stringify({progress:'shopify-full-history',expected,cutoff}));
    const fields='id,name,order_number,po_number,created_at,processed_at,email,phone,note,shipping_address,billing_address,customer,line_items,cancelled_at,closed_at,fulfillment_status,financial_status';
    let next=`https://${SHOP}/admin/api/2026-01/orders.json?status=any&limit=250&${range}&fields=${fields}`,pages=0;
    const orders=[],ids=new Set();
    while(next){
        if(++pages>100)throw Error('SHOPIFY_PAGINATION_INCOMPLETE');
        const page=await get(next);
        if(!Array.isArray(page.body.orders))throw Error('SHOPIFY_ORDERS_INVALID');
        for(const order of page.body.orders){if(ids.has(String(order.id)))throw Error('SHOPIFY_DUPLICATE_PAGE');ids.add(String(order.id));orders.push(order);}
        next=page.link.match(/<([^>]+)>;\s*rel="next"/)?.[1]||null;
        if(next)await new Promise(resolve=>setTimeout(resolve,550));
    }
    if(orders.length!==expected)throw Error(`SHOPIFY_ORDER_COUNT_MISMATCH_EXPECTED_${expected}_READ_${orders.length}_PAGES_${pages}`);
    const accessibleOpenOrderCount=orders.filter(o=>!o.closed_at&&!o.cancelled_at).length;
    return {orders,pages,cutoff,expected,earliest,fullHistoryAccess,storeOrderCount,storeOpenOrderCount,accessibleOpenOrderCount};
}

async function scope(client) {
    const rows=(await client.query("select * from store_integrations where id=4 and account_name=$1 and store_identifier=$2 and provider='SHOPIFY' and is_active",[ACCOUNT,SHOP])).rows;
    if(rows.length!==1)throw Error('RANCHERS_SCOPE_MISMATCH');
    const location=await client.query("select id from fulfillment_locations where id=1 and code='GW3PL-MISS'");
    if(location.rowCount!==1)throw Error('RANCHERS_WAREHOUSE_MISMATCH');
    return rows[0];
}

function summarize(order) {
    return {shopifyOrder:order.name,externalId:String(order.id),cancelled:!!order.cancelled_at,
        fulfillmentStatus:order.fulfillment_status,financialStatus:order.financial_status,createdAt:order.created_at,
        lines:(order.line_items||[]).map(l=>({id:String(l.id),productId:l.product_id,variantId:l.variant_id,sku:l.sku||'',
            title:l.title,variant:l.variant_title,quantity:l.quantity,currentQuantity:l.current_quantity,
            fulfillableQuantity:l.fulfillable_quantity,requiresShipping:l.requires_shipping}))};
}

async function audit(client,row,source) {
    const imports=(await client.query(`select s.external_order_id,o.id,o.order_code,o.status,o.fulfillment_location_id
        from store_order_imports s join portal_orders o on o.id=s.portal_order_id
        where s.integration_id=4 and o.account_name=$1`,[ACCOUNT])).rows;
    const ids=new Set(imports.map(r=>String(r.external_order_id).split('/').pop()));
    const canadian=source.orders.filter(o=>String(o.shipping_address?.country_code||'').toUpperCase()==='CA');
    const missing=canadian.filter(o=>!ids.has(String(o.id))),counts={};
    for(const item of imports)counts[item.status]=(counts[item.status]||0)+1;
    const catalog=(await client.query('select sku,description,tracking_level,unit_uom,units_per_case,upc from item_catalog where account_name=$1 order by sku',[ACCOUNT])).rows;
    const mappings=(await client.query('select external_sku,local_sku,local_quantity_multiplier from store_sku_mappings where integration_id=4 and account_name=$1 order by external_sku',[ACCOUNT])).rows;
    return {checkedAt:new Date().toISOString(),account:ACCOUNT,cutoff:source.cutoff,shopifyAccessibleOrderCount:source.expected,pages:source.pages,
        fullHistoryAccess:source.fullHistoryAccess,earliestAccessibleAt:source.earliest,totalShopifyStoreOrders:source.storeOrderCount,
        totalShopifyOpenOrders:source.storeOpenOrderCount,accessibleShopifyOpenOrders:source.accessibleOpenOrderCount,
        olderOpenOrdersNotAccessible:Math.max(0,source.storeOpenOrderCount-source.accessibleOpenOrderCount),
        canadaOrderCount:canadian.length,matchedCanadaOrderCount:canadian.length-missing.length,importedWmsOrderCount:imports.length,
        pendingCanadaOrderCount:canadian.filter(isPendingCanadian).length,
        missingPendingOrders:missing.filter(isPendingCanadian).map(summarize),
        statusCounts:counts,missingOrders:missing.map(summarize),catalog,mappings,lastSyncedAt:row.last_synced_at,lastSyncStatus:row.last_sync_status};
}

async function main(args=[]) {
    const mode=args[0]||'--audit';
    if(args.length>1||!['--audit','--test','--apply','--release'].includes(mode))throw Error('RECONCILIATION_MODE_INVALID');
    const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:20000});await client.connect();
    try{
        if(mode==='--test'){
            await client.query('begin');
            const company=await require('./designated-test-company').requireDesignatedTestCompany(client),api=businessApi(),sku='TEST-RANCHERS-SV-EA';
            const order={id:'TEST-PREORDER',name:'TEST-PREORDER',created_at:new Date().toISOString(),financial_status:'paid',
                shipping_address:{name:'Test Recipient',address1:'1330 Courtney Park Drive East',city:'Mississauga',province_code:'ON',zip:'L5T1V5',country_code:'CA',phone:'0000000000'},
                line_items:[{id:'TEST-LINE',product_id:10349591724333,variant_id:52353121681709,title:"PREORDER - Rancher's Salt & Vinegar",variant_title:'12 Pack',sku:'',quantity:1,fulfillable_quantity:1,requires_shipping:true}]};
            assert.equal(isPendingCanadian({...order,cancelled_at:new Date().toISOString()}),false);
            assert.equal(isPendingCanadian({...order,shipping_address:{country_code:'US'}}),false);
            assert.throws(()=>preparePreorder({...order,line_items:[{...order.line_items[0],variant_id:1}]}),/UNREVIEWED/);
            await ensurePreorderItem(client,api,company.name,sku);
            const saved=await savePreorder(client,api,order,company.name,sku,true);
            await client.query('savepoint zero_stock_release');
            await assert.rejects(()=>api.releasePortalOrderForAccount(client,company.name,saved.id,{rushExempt:true,activityActor:'Designated test verifier'}),/stock|available|inventory|quantity/i);
            await client.query('rollback to savepoint zero_stock_release');
            const bin='GW3PL-MISS-TESTSV-'+Date.now().toString(36).toUpperCase();
            await client.query("insert into bin_locations(code,note,location_type,is_pickable) values($1,'Designated test rollback fixture','STORAGE',true)",[bin]);
            await api.upsertInventoryLine(client,{accountName:company.name,location:bin,sku,quantity:12,trackingLevel:'UNIT'},
                {sourceType:'TEST_RECONCILIATION',sourceId:'TEST-RANCHERS-SV',idempotencyKey:'TEST-RANCHERS-SV-'+Date.now()});
            const released=await api.releasePortalOrderForAccount(client,company.name,saved.id,{rushExempt:true,activityActor:'Designated test verifier'});
            assert.equal(released.status,'RELEASED');
            const allocated=(await client.query('select coalesce(sum(allocated_quantity),0)::int quantity from portal_order_allocations where order_id=$1',[saved.id])).rows[0].quantity;
            assert.equal(allocated,12);
            await client.query('rollback');
            const report={mode,testCompany:company.name,rolledBack:true,emailsSent:0,shopifyWrites:0,testInventoryRolledBack:true,assertions:11};
            console.log(JSON.stringify(report));return report;
        }
        await client.query('begin read only');const row=await scope(client),source=await fetchAll(row);let report=await audit(client,row,source);await client.query('rollback');
        if(mode==='--apply'){
            const missingIds=new Set(report.missingPendingOrders.map(o=>o.externalId));
            const pending=source.orders.filter(o=>missingIds.has(String(o.id))).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
            pending.forEach(o=>preparePreorder(o));
            const api=businessApi(),imported=[];
            for(const order of pending){
                await client.query('begin');await client.query("set local lock_timeout='5s'");await client.query("set local statement_timeout='30s'");
                try{
                    await scope(client);
                    const existing=await api.lockAndFindStoreOrderImport(client,4,String(order.id));
                    if(existing){await client.query('rollback');continue;}
                    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[ACCOUNT+':'+PREORDER_SKU]);
                    await ensurePreorderItem(client,api);
                    assert.equal((await client.query('select count(*)::int count from inventory_lines where account_name=$1 and sku=$2',[ACCOUNT,PREORDER_SKU])).rows[0].count,0);
                    const saved=await savePreorder(client,api,order);
                    await client.query('insert into store_order_imports(integration_id,external_order_id,portal_order_id) values(4,$1,$2)',[String(order.id),saved.id]);
                    await client.query(`insert into shopify_tracking_order_contacts(integration_id,order_id,account_name,external_order_id,recipient_email,shopify_order_number)
                        values(4,$1,$2,$3,$4,$5)`,[saved.id,ACCOUNT,String(order.id),String(order.email||'').trim().toLowerCase(),order.name]);
                    await client.query('commit');imported.push({shopifyOrder:order.name,wmsOrder:saved.orderCode||saved.order_code,status:'DRAFT',bags:12});
                }catch(error){await client.query('rollback');throw error;}
            }
            await client.query('begin read only');report=await audit(client,await scope(client),source);await client.query('rollback');
            assert.equal(report.missingPendingOrders.length,0);
            report={...report,mode,imported,emailsSent:0,shopifyWrites:0,inventoryWrites:0};
        }
        if(mode==='--release'){
            if(report.missingPendingOrders.length)throw Error('IMPORT_PENDING_ORDERS_BEFORE_RELEASE');
            const api=businessApi(),byId=new Map(source.orders.filter(isPendingCanadian).map(o=>[String(o.id),o]));
            const drafts=(await client.query(`select o.id,o.order_code,o.fulfillment_location_id,s.external_order_id
                from portal_orders o join store_order_imports s on s.portal_order_id=o.id and s.integration_id=4
                where o.account_name=$1 and o.status='DRAFT' order by o.created_at,o.id`,[ACCOUNT])).rows;
            const released=[],blocked=[];
            const lookup=new Map(report.mappings.map(m=>[m.external_sku.toUpperCase(),{localSku:m.local_sku,localQuantityMultiplier:m.local_quantity_multiplier}]));
            for(const draft of drafts){
                const shopify=byId.get(String(draft.external_order_id));
                if(!shopify||Number(draft.fulfillment_location_id)!==1){blocked.push({order:draft.order_code,reason:'Not a verified pending Canadian order in Mississauga'});continue;}
                await client.query('begin');await client.query("set local lock_timeout='5s'");await client.query("set local statement_timeout='30s'");
                try{
                    await scope(client);
                    const locked=(await client.query('select status from portal_orders where id=$1 and account_name=$2 and fulfillment_location_id=1 for update',[draft.id,ACCOUNT])).rows[0];
                    if(locked?.status!=='DRAFT'){await client.query('rollback');continue;}
                    const physical={...shopify,line_items:shopify.line_items.filter(l=>l.requires_shipping!==false&&Number(l.fulfillable_quantity??l.current_quantity??l.quantity)>0)};
                    const prepared=physical.line_items.some(l=>!String(l.sku||'').trim())?preparePreorder(physical):physical;
                    const payload=api.applyStoreSkuMappingsToPortalOrderPayload(api.mapShopifyOrderToPortalDraft(ACCOUNT,prepared,{store_identifier:SHOP}),lookup);
                    function totals(lines){const m=new Map();for(const l of lines)m.set(l.sku,(m.get(l.sku)||0)+Number(l.quantity));return [...m].sort((a,b)=>a[0].localeCompare(b[0]));}
                    const lines=(await client.query('select sku,requested_quantity as quantity from portal_order_lines where order_id=$1',[draft.id])).rows;
                    assert.deepEqual(totals(lines),totals(payload.lines),'Shopify/WMS item or remaining quantity mismatch');
                    const order=await api.releasePortalOrderForAccount(client,ACCOUNT,draft.id,{rushExempt:true,
                        rushExemptNote:'Owner approved standard release; retain four-business-day processing, no rush charge.',
                        activityActor:'Owner approved Ranchers stock-backed release',activityTitlePrefix:'Shopify stock-backed'});
                    assert.equal(order.status,'RELEASED');
                    const sums=await client.query(`select l.id,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::int allocated
                        from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
                        where l.order_id=$1 group by l.id,l.requested_quantity`,[draft.id]);
                    for(const line of sums.rows)assert.equal(Number(line.requested_quantity),line.allocated);
                    await client.query('commit');released.push({order:draft.order_code,shopifyOrder:shopify.name});
                }catch(error){await client.query('rollback');blocked.push({order:draft.order_code,
                    reason:typeof error.statusCode==='number'&&error.statusCode<500?String(error.message).slice(0,240):error.code||'Release validation failed; review required'});}
            }
            await client.query('begin read only');report=await audit(client,await scope(client),source);await client.query('rollback');
            report={...report,mode,releasedCount:released.length,released,blockedCount:blocked.length,blocked,shopifyWrites:0};
        }
        console.log(JSON.stringify(report));return report;
    }
    catch(error){await client.query('rollback');throw error;}
    finally{await client.end();}
}
module.exports={main,fetchAll,scope,audit,summarize,isPendingCanadian,preparePreorder,ACCOUNT,SHOP};
