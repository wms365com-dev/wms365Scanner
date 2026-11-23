"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const worker=require("./shopify-tracking-worker");
const {createShopifyTrackingApi,decrypt}=require("./shopify-tracking-api");
const row={id:1,account_name:"TEST COMPANY",provider:"SHOPIFY",store_identifier:"fixture.myshopify.com",is_active:true,
    settings:{carrierFulfillmentEventsEnabled:true,publicCarrierTrackingEnabled:true}};
test("public monitoring requires explicit active integration opt-in, not merely customer membership",()=>{
    assert.equal(worker.canTrack(row),true);
    for(const patch of [{is_active:false},{provider:"OTHER"},{settings:{}},{settings:{carrierFulfillmentEventsEnabled:true}}])
        assert.equal(worker.canTrack({...row,...patch}),false);
});
test("remote fulfillment discovery rejects foreign stores/orders and truncated membership",()=>{
    const data={shop:{myshopifyDomain:row.store_identifier},order:{id:"gid://shopify/Order/11",fulfillmentsCount:{count:1},
        fulfillments:[{id:"gid://shopify/Fulfillment/12",status:"SUCCESS",displayStatus:"FULFILLED",trackingInfo:[{number:"TEST"}]}]}};
    assert.equal(worker.validateRemote(row,{external_order_id:"11"},data).length,1);
    assert.throws(()=>worker.validateRemote({...row,store_identifier:"foreign.myshopify.com"},{external_order_id:"11"},data));
    assert.throws(()=>worker.validateRemote(row,{external_order_id:"22"},data));
    assert.throws(()=>worker.validateRemote(row,{external_order_id:"11"},{...data,order:{...data.order,fulfillmentsCount:{count:2}}}));
    data.order.fulfillments[0].displayStatus="DELIVERED";
    assert.equal(worker.validateRemote(row,{external_order_id:"11"},data).length,0);
});
test("historical scans preserve explicit timezone, reject future/guessed/unauthorized observed timestamps",()=>{
    const scan={ok:true,carrier:"GLS",status:"DELIVERED",eventAt:"2026-09-16T12:00:00-04:00",timeBasis:"CARRIER_OFFSET_TIMESTAMP"};
    const tracker={tracking_number:"TEST",carrier_name:"GLS"};
    const event=worker.scanEvent(tracker,scan,"2026-09-17T20:00:00Z");
    assert.equal(event.at,"2026-09-16T16:00:00.000Z");
    assert.equal(event.source,"GLS_BROWSER");
    assert.throws(()=>worker.scanEvent(tracker,{...scan,eventAt:"2026-09-16 12:00:00"},"2026-09-17T20:00:00Z"));
    assert.throws(()=>worker.scanEvent(tracker,{...scan,eventAt:"2026-09-18T12:00:00Z"},"2026-09-17T20:00:00Z"));
    assert.throws(()=>worker.scanEvent(tracker,{...scan,timeBasis:"OBSERVED_CONFIRMED_STATUS"},"2026-09-17T20:00:00Z"));
    assert.throws(()=>worker.scanEvent(tracker,{...scan,eventAt:"2026-02-30T12:00:00Z"},"2026-09-17T20:00:00Z"));
    assert.throws(()=>worker.scanEvent(tracker,scan,"invalid"));
});
test("an older carrier scan releases its claim without replacing newer status or publishing a regression",async()=>{
    const queries=[];
    const client={release(){},async query(sql,args){
        queries.push({sql,args});
        if(sql.startsWith("select t.*")) return {rows:[{last_event_at:"2026-09-17T12:00:00Z",status:"EXCEPTION"}]};
        if(sql.startsWith("select feature_flags")) return {rows:[{feature_flags:null}]};
        if(sql.startsWith("select * from store_integrations")) return {rows:[row]};
        if(sql.startsWith("insert into shipment_tracking_events")) return {rows:[{event_at:args[6]}]};
        return {rows:[]};
    }};
    const saved=await worker.storeScan({connect:async()=>client},{id:1,integration_id:1,account_name:row.account_name,
        tracking_number:"TEST",carrier_name:"GLS",enrolled_at:"2026-09-10T12:00:00Z",expires_at:"2026-10-25T12:00:00Z",tracking_poll_minutes:45},
        {ok:true,carrier:"GLS",status:"DELIVERED",eventAt:"2026-09-16T12:00:00Z",timeBasis:"CARRIER_OFFSET_TIMESTAMP"},"claim","2026-09-17T20:00:00Z");
    assert.equal(saved,false);
    assert.ok(queries.some(({sql})=>sql.includes("set last_checked_at=$2") && sql.includes("claimed_by=''")));
    assert.ok(!queries.some(({sql})=>sql.includes("set status=$2")));
    assert.equal(queries.at(-1).sql,"commit");
});
test("approved recorded time preserves local scan and deduplicates later observations",()=>{
    const settings={carrierUnverifiedTimeMode:"OBSERVED",carrierObservedTimeApprovedAt:"2026-09-17T19:00:00Z"};
    const tracker={tracking_number:"TEST",carrier_name:"ICS Courier",integration_settings:settings};
    const scan={ok:true,carrier:"ICS_COURIER",status:"DELIVERED",eventAt:"2026-09-17T20:00:00Z",timeBasis:"OBSERVED_CONFIRMED_STATUS",carrierLocalTimestamp:"2026-09-14 11:57:02"};
    const first=worker.scanEvent(tracker,scan,"2026-09-17T20:00:00Z");
    const later=worker.scanEvent(tracker,{...scan,eventAt:"2026-09-17T21:00:00Z"},"2026-09-17T21:00:00Z");
    assert.equal(first.eventKey,later.eventKey);
    assert.equal(first.metadata.carrier_local_timestamp,scan.carrierLocalTimestamp);
    assert.equal(first.metadata.observed_time_approved_at,settings.carrierObservedTimeApprovedAt);
    assert.throws(()=>worker.scanEvent({...tracker,integration_settings:{carrierUnverifiedTimeMode:"OBSERVED"}},scan,"2026-09-17T20:00:00Z"));
    const sync=require("./shopify-tracking-sync");
    assert.match(sync.carrierEventMessage([{safe_metadata:first.metadata}]),/recording time, not actual delivery time/);
    assert.match(sync.carrierEventMessage([{safe_metadata:first.metadata}]),/2026-09-14 11:57:02/);
    assert.throws(()=>sync.carrierEventMessage([{safe_metadata:{time_basis:"OBSERVED_CONFIRMED_STATUS"}}]));
});
test("a repeated observed scan keeps its first recorded timestamp and does not invent actual delivery time",async()=>{
    const queries=[];
    const approved={...row,settings:{...row.settings,carrierUnverifiedTimeMode:"OBSERVED",carrierObservedTimeApprovedAt:"2026-09-17T19:00:00Z"}};
    const client={release(){},async query(sql,args){
        queries.push({sql,args});
        if(sql.startsWith("select t.*")) return {rows:[{last_event_at:"2026-09-17T20:00:00Z",status:"IN_TRANSIT"}]};
        if(sql.startsWith("select feature_flags")) return {rows:[{feature_flags:null}]};
        if(sql.startsWith("select * from store_integrations")) return {rows:[approved]};
        if(sql.startsWith("select event_at from shipment_tracking_events")) return {rows:[{event_at:"2026-09-17T20:00:00Z"}]};
        return {rows:[]};
    }};
    await worker.storeScan({connect:async()=>client},{id:1,integration_id:1,account_name:row.account_name,tracking_number:"TEST",carrier_name:"ICS",
        enrolled_at:"2026-09-10T12:00:00Z",expires_at:"2026-10-25T12:00:00Z",tracking_poll_minutes:45},
        {ok:true,carrier:"ICS_COURIER",status:"IN_TRANSIT",eventAt:"2026-09-17T21:00:00Z",timeBasis:"OBSERVED_CONFIRMED_STATUS",carrierLocalTimestamp:"2026-09-14 11:57:02"},
        "claim","2026-09-17T21:00:00Z");
    const update=queries.find(({sql})=>sql.includes("set status=$2"));
    assert.equal(update.args[3],"2026-09-17T20:00:00.000Z");
    assert.equal(update.args[6],"OBSERVED_CONFIRMED_STATUS");
    assert.match(update.sql,/and \$7='CARRIER_OFFSET_TIMESTAMP'/);
});
test("credential requests require a Shopify host and cannot redirect or target other API paths",async()=>{
    let calls=0;
    const api=createShopifyTrackingApi({fetchImpl:async()=>{calls+=1;throw Error("must not reach network");}});
    await assert.rejects(api.request({...row,store_identifier:"localhost"},"/graphql.json"));
    await assert.rejects(api.request(row,"/orders.json"));
    assert.equal(calls,0);
    assert.throws(()=>decrypt("enc:v1:bad:bad:bad",{}));
});
test("integration permission check requires exact Shopify store and write_fulfillments",async()=>{
    const calls=[];
    let domain="foreign.myshopify.com";
    let scopes=[];
    const api=createShopifyTrackingApi({fetchImpl:async(url,opts)=>{
        calls.push({url,opts});return {ok:true,json:async()=>({data:{shop:{myshopifyDomain:domain},
            currentAppInstallation:{accessScopes:scopes}}})};
    }});
    const active={...row,access_token:"fixture-token"};
    await assert.rejects(api.verify(active));
    domain=row.store_identifier;await assert.rejects(api.verify(active));
    scopes=[{handle:"write_fulfillments"}];await api.verify(active);
    assert.equal(calls[0].opts.redirect,"error");
    assert.equal(calls[0].url,"https://fixture.myshopify.com/admin/api/2026-07/graphql.json");
});
test("historical replay requires owner audit and freshly recorded offset-bearing proof, without backdating enrollment",()=>{
    const fs=require("node:fs");
    const source=fs.readFileSync(require.resolve("./shopify-tracking-sync"),"utf8");
    assert.match(source,/e\.created_at>=f\.historical_delivery_approved_at/);
    assert.match(source,/time_basis'='CARRIER_OFFSET_TIMESTAMP'/);
    assert.match(source,/c\.action='REPLAY_EVENTS'/);
    assert.match(source,/expected_tracking_numbers\.length===approved\.rows\.length/);
    assert.match(source,/newer\.status<>'DELIVERED'/);
    const workerSource=fs.readFileSync(require.resolve("./shopify-tracking-worker"),"utf8");
    assert.doesNotMatch(workerSource,/update .*enrolled_at\s*=/);
    assert.match(workerSource,/i\.id=\$1/);
    assert.match(workerSource,/manual_closed_at is null/);
});

test("worker reports rejected carrier checks separately from confirmed scans without private text",async()=>{
    const queries=[];
    const tracker={id:1,integration_id:1,account_name:row.account_name,carrier_key:"CANPAR",carrier_name:"Canpar",
        tracking_number:"TEST",enrolled_at:"2026-09-10T12:00:00Z",expires_at:"2026-10-25T12:00:00Z",tracking_poll_minutes:45};
    const client={release(){},async query(sql,args){
        queries.push({sql,args});
        if(sql.startsWith("select t.*,f.integration_id"))return {rows:[tracker]};
        if(sql.startsWith("select t.* from shipment_trackers"))return {rows:[{attempts:0}]};
        if(sql.startsWith("select feature_flags"))return {rows:[{feature_flags:null}]};
        if(sql.startsWith("select * from store_integrations"))return {rows:[row]};
        return {rows:[]};
    }};
    const report=await worker.pollDue({connect:async()=>client},1,{poll:async()=>({ok:false,code:"LAYOUT_REVIEW_REQUIRED"})},{wait:async()=>{}});
    assert.deepEqual(report,{checked:1,confirmed:0,failed:1,errors:{"CANPAR:LAYOUT_REVIEW_REQUIRED":1}});
    assert.doesNotMatch(JSON.stringify(report),/TEST COMPANY|tracking_number|account_name/);
    const sql=queries.find(q=>q.sql.startsWith("select t.*,f.integration_id")).sql;
    for(const guard of ["i.id=$1","i.account_name=f.account_name","t.manual_closed_at is null","t.status<>'DELIVERED'","f.expires_at>now()"])
        assert.ok(sql.includes(guard));
    assert.ok(queries.some(q=>q.sql.includes("claimed_by='',claimed_at=null")));
});

test("carrier errors use reviewed codes only and retry-after cannot exceed one day",()=>{
    assert.equal(worker.safeError(Error("PRIVATE_CUSTOMER_TRACKING_123")),"TRACKING_PROCESSING_FAILED");
    assert.equal(worker.safeError({code:"CARRIER_RATE_LIMITED"}),"CARRIER_RATE_LIMITED");
    assert.equal(worker.safeError(Error("PRIVATE_EMAIL_ADDRESS"),"TRACKING_CYCLE_FAILED"),"TRACKING_CYCLE_FAILED");
    assert.equal(worker.safeError(Error("WRITE_FULFILLMENTS_REQUIRED"),"TRACKING_CYCLE_FAILED"),"WRITE_FULFILLMENTS_REQUIRED");
    const source=require("node:fs").readFileSync(require.resolve("./shopify-tracking-worker"),"utf8");
    assert.doesNotMatch(source,/String\(error\.code \|\| error\.message\)\.replace/);
    const at="2026-09-18T12:00:00Z";
    assert.equal(worker.retryCheckAt(1,at,900000),"2026-09-18T12:15:00.000Z");
    assert.equal(worker.retryCheckAt(1,at,Infinity),"2026-09-18T12:02:00.000Z");
    assert.equal(worker.retryCheckAt(1,at,1e12),"2026-09-19T12:00:00.000Z");
    assert.throws(()=>worker.scanEvent({carrier_name:"ICS",tracking_number:"TEST"},
        {ok:true,carrier:"GLS",status:"DELIVERED",eventAt:at,timeBasis:"CARRIER_OFFSET_TIMESTAMP"},at),/CARRIER_IDENTITY_MISMATCH/);
});

function batchFixture({badInsert=false}={}) {
    const queries=[];
    const trackers=[1,2].map(id=>({id,integration_id:1,account_name:row.account_name,carrier_key:"GLS",carrier_name:"GLS",
        tracking_number:`TEST-${id}`,enrolled_at:"2026-09-10T12:00:00Z",expires_at:"2080-01-01T00:00:00Z",tracking_poll_minutes:45}));
    const client={release(){},async query(sql,args){
        queries.push({sql,args});
        if(sql.startsWith("select t.*,f.integration_id"))return {rows:trackers};
        if(sql.startsWith("select t.* from shipment_trackers"))return {rows:[{attempts:0,last_event_at:null}]};
        if(sql.startsWith("select feature_flags"))return {rows:[{feature_flags:null}]};
        if(sql.startsWith("select * from store_integrations"))return {rows:[row]};
        if(sql.startsWith("insert into shipment_tracking_events")) {
            if(badInsert && args[0]===1) throw Error("PRIVATE_CUSTOMER_TEXT");
            return {rows:[{event_at:args[6]}]};
        }
        return {rows:[]};
    }};
    return {queries,pool:{connect:async()=>client}};
}

const verifiedScan=()=>({ok:true,carrier:"GLS",status:"IN_TRANSIT",eventAt:"2026-09-16T12:00:00Z",timeBasis:"CARRIER_OFFSET_TIMESTAMP"});

test("an invalid carrier result does not prevent a later valid shipment from being processed",async()=>{
    const {pool,queries}=batchFixture();
    let calls=0,published=0;
    const report=await worker.pollDue(pool,1,{poll:async()=>++calls===1 ? {...verifiedScan(),carrier:"CANPAR"} : verifiedScan()},
        {wait:async()=>{},onConfirmed:async()=>{published++;}});
    assert.deepEqual(report,{checked:2,confirmed:1,failed:1,errors:{"GLS:CARRIER_IDENTITY_MISMATCH":1}});
    assert.equal(published,1);
    assert.equal(queries.filter(q=>q.sql.startsWith("insert into shipment_tracking_events")).length,1);
    const failure=queries.find(q=>q.sql.includes("attempts=$2"));
    assert.equal(failure.args[3],"CARRIER_IDENTITY_MISMATCH");
    assert.match(queries.find(q=>q.sql.startsWith("select t.* from shipment_trackers")).sql,/t\.is_active and t\.status<>'DELIVERED'/);
});

test("a rolled-back scan is retried safely and does not poison the rest of the batch",async()=>{
    const {pool,queries}=batchFixture({badInsert:true});
    const report=await worker.pollDue(pool,1,{poll:async()=>verifiedScan()},{wait:async()=>{}});
    assert.equal(report.confirmed,1);
    assert.equal(report.failed,1);
    assert.deepEqual(report.errors,{"GLS:TRACKING_PROCESSING_FAILED":1});
    assert.ok(queries.some(q=>q.sql==="rollback"));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_CUSTOMER/);
    assert.ok(queries.some(q=>q.sql.includes("attempts=$2") && q.args[3]==="TRACKING_PROCESSING_FAILED"));
});

test("callback failure releases unprocessed claims without releasing another worker's ownership",async()=>{
    const {pool,queries}=batchFixture();
    await assert.rejects(worker.pollDue(pool,1,{poll:async()=>verifiedScan()},
        {wait:async()=>{},onConfirmed:async()=>{throw Error("publish unavailable");}}));
    const cleanup=queries.find(q=>q.sql.includes("where claimed_by=$1 and id=any($2::bigint[])"));
    assert.deepEqual(cleanup.args[1],[1,2]);
    assert.ok(cleanup.args[0]);
    assert.equal(queries.filter(q=>q.sql.startsWith("insert into shipment_tracking_events")).length,1);
    for(const limit of [0,-1,251,1.5,NaN]) await assert.rejects(worker.pollDue(pool,1,{}, {limit}),/WORKER_BATCH_LIMIT_INVALID/);
});

test("one foreign discovery response does not block other orders and degrades reported quality",async()=>{
    const orders=[{id:1,external_order_id:"11"},{id:2,external_order_id:"22"}];
    const pool={query:async()=>({rows:orders})};
    let calls=0;
    const api={request:async()=>({payload:{data:{shop:{myshopifyDomain:++calls===1 ? "foreign.myshopify.com" : row.store_identifier},
        order:{id:`gid://shopify/Order/${calls===1 ? "11" : "22"}`,fulfillmentsCount:{count:0},fulfillments:[]}}}})};
    const discovery=await worker.discover(pool,row,api);
    assert.equal(calls,2);
    assert.deepEqual(discovery,{orders:2,bound:0,failed:1,errors:{REMOTE_OWNERSHIP_MISMATCH:1}});
    const report={polling:{failed:0},failed:0,unresolved:0,discovery};
    assert.match(worker.trackingWarning(report),/DISCOVERY_FAILURES_1/);
    assert.equal(worker.trackingHealth({running:true,heartbeat:1000,latestReport:report},2000).quality,"DEGRADED");
});

test("time-bounded batches release deferred records and report progress without faking checks",async()=>{
    const {pool,queries}=batchFixture();
    let clock=0,progress=0;
    const report=await worker.pollDue(pool,1,{poll:async()=>verifiedScan()},
        {clock:()=>clock,timeBudgetMs:30000,wait:async()=>{clock=30000;},onProgress:()=>{progress++;}});
    assert.deepEqual(report,{checked:1,confirmed:1,failed:0,errors:{},deferred:1});
    assert.equal(progress,1);
    assert.ok(queries.some(q=>q.sql.includes("where claimed_by=$1 and id=any($2::bigint[])")));
    for(const timeBudgetMs of [0,29999,1200001,NaN]) await assert.rejects(worker.pollDue(pool,1,{}, {timeBudgetMs}),/WORKER_TIME_BUDGET_INVALID/);
});

test("a no-op cycle cannot hide unresolved checks awaiting retry",()=>{
    const report={polling:{checked:0,confirmed:0,failed:0,errors:{}},failed:0,unresolved:3};
    assert.match(worker.trackingWarning(report),/UNRESOLVED_3/);
    const health=worker.trackingHealth({running:true,heartbeat:1000,latestReport:report,lastCycleFailed:false,lastSuccessAt:"2026-09-18T12:00:00Z"},2000);
    assert.equal(health.healthy,true);
    assert.equal(health.quality,"DEGRADED");
    assert.equal(health.tracking.unresolved,3);
    assert.equal(worker.trackingWarning({...report,unresolved:0}),"");
});

test("cycle failure cannot present old successful tracking as current health",()=>{
    const report={polling:{checked:47,confirmed:47,failed:0,errors:{}},failed:0,unresolved:0};
    const state={running:true,heartbeat:1000,latestReport:report,lastCycleFailed:true,lastSuccessAt:"2026-09-18T12:00:00Z"};
    const health=worker.trackingHealth(state,2000);
    assert.equal(health.healthy,true);
    assert.equal(health.quality,"DEGRADED");
    assert.equal(health.warning,"TRACKING_CYCLE_FAILED");
    assert.equal(health.lastSuccessAt,state.lastSuccessAt);
    assert.equal(worker.trackingHealth({...state,lastCycleFailed:false},2000).quality,"OK");
    assert.equal(worker.trackingHealth({...state,latestReport:null,lastCycleFailed:false},2000).quality,"STARTING");
    assert.equal(worker.trackingHealth({...state,running:false},2000).healthy,false);
    assert.equal(worker.trackingHealth(state,31*60000).healthy,false);
});

test("unresolved health counts retain exact store, tenant, shipment and warehouse boundaries without a due-date filter",async()=>{
    let query;
    const count=await worker.unresolvedChecks({query:async(sql,args)=>{query={sql,args};return {rows:[{count:2}]};}},7);
    assert.equal(count,2);
    assert.equal(query.args[0],7);
    for(const guard of ["count(distinct t.id)","i.id=$1","i.account_name=f.account_name","i.store_identifier=f.store_identifier",
        "p.fulfillment_location_id=t.fulfillment_location_id","p.warehouse_shipment_id=t.warehouse_shipment_id",
        "t.manual_closed_at is null","t.status<>'DELIVERED'","f.expires_at>now()","t.last_error<>''"])
        assert.ok(query.sql.includes(guard));
    assert.doesNotMatch(query.sql,/next_poll_at|claimed_at/);
});

test("fulfillment rediscovery preserves the scheduled check and retry count",async()=>{
    const queries=[];
    const client={async query(sql,args){queries.push({sql,args});return {
        rows:sql.startsWith("insert into shopify_tracking_fulfillments") ? [{id:7,enrolled_at:"2026-09-18T12:00:00Z",expires_at:"2080-01-01T00:00:00Z"}] : []};}};
    await require("./shopify-tracking-sync").bindFulfillment(client,row,{id:1,accountName:row.account_name},"11",{id:"12"},["TEST"]);
    const update=queries.find(q=>q.sql.startsWith("update shipment_trackers t"));
    assert.match(update.sql,/else coalesce\(t.next_poll_at,now\(\)\)/);
    assert.doesNotMatch(update.sql,/attempts\s*=|last_error\s*=/);
    assert.match(update.sql,/t.claimed_at is null and t.manual_closed_at is null/);
    assert.equal(update.args[0],7);
});
