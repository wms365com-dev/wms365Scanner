"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {extractSnapshot,extractCanpar,createPublicHttpTracking,retryAfterMs,MAX_HTML}=require("./carrier-public-http");
test("HTML parsing binds the nonprint shipment identity and rejects changed scan layouts",()=>{
    const html=`<body><div class="hidden"><span>TEST-1</span></div><span class="font-bold text-xl">TEST-1</span>
        <table><tr><th>Status</th><th>Location</th><th>Date</th><th>Time</th></tr>
        <tr><td><div>Delivered <span class="text-sm">Your shipment was delivered.</span></div></td><td>TEST</td><td>9/16/2026</td><td>4:00:00 PM</td></tr></table>
        <table><tr><th>#</th><th>Type</th><th>Quantity</th><th>Weight</th><th>Dimensions</th></tr><tr><td>1</td><td>Box</td><td>1</td><td>2lb</td><td>test</td></tr></table>
        <script id="__NUXT_DATA__">[]</script></body>`;
    const snapshot=extractSnapshot("GLS","TEST-1",html);
    assert.deepEqual(snapshot.identities,["TEST-1"]);
    assert.equal(snapshot.rows[1][0],"Delivered\nYour shipment was delivered.");
    assert.equal(snapshot.renderingTimezone,"UTC_SERVER_RENDERED");
    assert.throws(()=>extractSnapshot("GLS","TEST-1",html.replace("Status","Changed")));
    assert.throws(()=>extractSnapshot("GLS","TEST-1","a".repeat(MAX_HTML+1)));
});

test("carrier throttling honors retry-after and does not hammer the carrier or invoke browser fallback",async()=>{
    let clock=Date.parse("2026-09-18T12:00:00Z"),calls=0,browserCalls=0;
    const reader=createPublicHttpTracking({now:()=>clock,fetchImpl:async()=>{
        calls++;
        return new Response("",{status:429,headers:{"retry-after":"900"}});
    },browserFallback:{poll:async()=>{browserCalls++;}}});
    assert.deepEqual(await reader.poll({carrier:"ICS",trackingNumber:"TEST-1"}),
        {ok:false,code:"CARRIER_RATE_LIMITED",retryAfterMs:900000,httpStatus:429});
    clock+=60000;
    assert.equal((await reader.poll({carrier:"ICS",trackingNumber:"TEST-2"})).retryAfterMs,840000);
    assert.equal(calls,1);
    await reader.poll({carrier:"GLS",trackingNumber:"TEST-1"});
    assert.equal(calls,2);
    clock+=840000;
    await reader.poll({carrier:"ICS",trackingNumber:"TEST-1"});
    assert.equal(calls,3);
    assert.equal(browserCalls,0);
});

test("service cooldowns and retry-after dates are bounded, while invalid headers use safe defaults",async()=>{
    const now=Date.parse("2026-09-18T12:00:00Z");
    assert.equal(retryAfterMs("Fri, 18 Sep 2026 12:20:00 GMT",now,1000),1200000);
    for(const value of ["bad","0","-5","Thu, 17 Sep 2026 12:00:00 GMT"]) assert.equal(retryAfterMs(value,now,1000),1000);
    assert.equal(retryAfterMs("999999999",now,1000),86400000);
    let calls=0;
    const reader=createPublicHttpTracking({now:()=>now,fetchImpl:async()=>{
        calls++;
        return new Response("",{status:503});
    }});
    assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"})).retryAfterMs,300000);
    assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-2"})).code,"CARRIER_UNAVAILABLE");
    assert.equal(calls,1);
});

test("browser fallback is layout-only, cannot bypass identity rejection, and cannot leak thrown private text",async()=>{
    let browserCalls=0;
    let body="<html><body>JS results pending</body></html>";
    const reader=createPublicHttpTracking({fetchImpl:async()=>new Response(body,{headers:{"content-type":"text/html"}}),
        browserFallback:{poll:async()=>{browserCalls++;throw Error("PRIVATE_CUSTOMER_NAME_AND_TRACKING");}}});
    assert.deepEqual(await reader.poll({carrier:"GLS",trackingNumber:"TEST-1"}),{ok:false,code:"CARRIER_BROWSER_FAILED"});
    assert.equal(browserCalls,1);
    const badIdentity={result:[{barcode:"FOREIGN",events:[]}]};
    const canpar=createPublicHttpTracking({fetchImpl:async()=>new Response(JSON.stringify(badIdentity),{headers:{"content-type":"application/json"}}),
        browserFallback:{poll:async()=>{browserCalls++;}}});
    assert.deepEqual(await canpar.poll({carrier:"Canpar",trackingNumber:"TEST-1"}),{ok:false,code:"TRACKING_ID_MISMATCH"});
    assert.equal(browserCalls,1);
});

test("oversized response declarations are rejected before body parsing",async()=>{
    const reader=createPublicHttpTracking({fetchImpl:async()=>new Response("short",{
        headers:{"content-type":"text/html","content-length":String(MAX_HTML+1)}})});
    assert.deepEqual(await reader.poll({carrier:"GLS",trackingNumber:"TEST-1"}),{ok:false,code:"PAYLOAD_LIMIT"});
});
test("public HTTP reader rejects redirects, nonHTML and unknown carriers without evaluating code",async()=>{
    let opts;
    const reader=createPublicHttpTracking({fetchImpl:async(_url,o)=>{opts=o;return {ok:true,headers:new Headers({"content-type":"application/json"})};}});
    assert.deepEqual(await reader.poll({carrier:"GLS",trackingNumber:"TEST-1"}),{ok:false,code:"CARRIER_HTTP_FAILED"});
    assert.equal(opts.redirect,"error");
    assert.equal(opts.method,"GET");
    assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"})).code,"CARRIER_HTTP_READ_FAILED");
});
test("Canpar structured delivery requires exact identity, physical DEL scan and matching summary",async()=>{
    const event={local_date_time:"20260916 171143",code:"DEL",code_description_en:"Our Package was Delivered",web_description_en:"Your shipment is delivered on"};
    const data={error:null,result:[{barcode:"TEST-1",delivered:true,events:[event]}]};
    assert.deepEqual(extractCanpar("TEST-1",data).rows,[["2026-09-16 17:11:43","Our Package was Delivered",""]]);
    for(const patch of [{error:"bad"},{result:[]},{result:[{...data.result[0],barcode:"OTHER"}]},{result:[data.result[0],data.result[0]]}])
        assert.throws(()=>extractCanpar("TEST-1",{...data,...patch}),/TRACKING_ID_MISMATCH/);
    assert.throws(()=>extractCanpar("TEST-1",{...data,result:[{...data.result[0],delivered:false}]}),/SCAN_CONFLICT/);
    let request;
    const reader=createPublicHttpTracking({now:()=>"2026-09-17T20:00:00Z",fetchImpl:async(url,opts)=>{
        request={url,opts};return new Response(JSON.stringify(data),{headers:{"content-type":"application/json"}});
    }});
    const held=await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"});
    assert.equal(held.code,"TIMEZONE_REQUIRED");
    assert.equal(held.proof.status,"DELIVERED");
    assert.equal(request.url,"https://canship.canpar.com/api/CanparAddons/trackByBarcodeV2");
    assert.deepEqual(JSON.parse(request.opts.body),{barcode:"TEST-1"});
    assert.equal(request.opts.redirect,"error");
    data.result[0].events.unshift({...event,local_date_time:"20260917 171143",code:"RETURN",code_description_en:"Unreviewed return",web_description_en:"Returned"});
    assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"})).code,"LAYOUT_REVIEW_REQUIRED");
});

test("Canpar no-signature NSR delivery requires reviewed scan wording and delivered summary",async()=>{
    const event={local_date_time:"20260916 171143",code:"NSR",
        code_description_en:"Your Package was Delivered with no Signature Required",
        web_description_en:"Your shipment has been delivered - No Signature was required"};
    const data={result:[{barcode:"TEST-1",delivered:true,events:[event]}]};
    const reader=createPublicHttpTracking({now:()=>"2026-09-17T20:00:00Z",fetchImpl:async()=>
        new Response(JSON.stringify(data),{headers:{"content-type":"application/json"}})});
    const result=await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"},{unverifiedTimeMode:"OBSERVED"});
    assert.equal(result.status,"DELIVERED");
    assert.equal(result.deliveredAt,null);
    data.result[0].delivered=false;
    assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"},{unverifiedTimeMode:"OBSERVED"})).code,"SCAN_CONFLICT");
    data.result[0].delivered=true;
    event.code_description_en="Estimated delivery, no signature required";
    assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"},{unverifiedTimeMode:"OBSERVED"})).code,"LAYOUT_REVIEW_REQUIRED");
});

test("ICS HTTP extraction binds current summary and rejects changed headers or multiple rows",()=>{
    const html=`<table id="fixture_gvresult"><tr><th>Tracking Number</th><th>Last Updated</th><th>Status</th><th>Signature</th><th>Est Delivery Date</th></tr>
        <tr><td>TEST-1</td><td>2026-09-16 12:00:15</td><td>Delivered at: Synthetic Person</td><td></td><td>2026-09-16</td></tr></table>
        <table id="fixture_gvTracingDetail"><tr><th>Date Time</th><th>Status</th></tr><tr><td>2026-09-16 12:00:15</td><td>Delivered at: Synthetic Person</td></tr></table>`;
    const snapshot=extractSnapshot("ICS_COURIER","TEST-1",html);
    assert.deepEqual(snapshot.currentScan,{local:"2026-09-16 12:00:15",label:"Delivered at: Synthetic Person"});
    assert.deepEqual(snapshot.identities,["TEST-1"]);
    assert.throws(()=>extractSnapshot("ICS_COURIER","TEST-1",html.replace("Last Updated","Changed")),/LAYOUT_REVIEW_REQUIRED/);
    assert.throws(()=>extractSnapshot("ICS_COURIER","TEST-1",html.replace("</td></tr></table>","</td></tr><tr><td>OTHER</td><td></td><td></td><td></td><td></td></tr></table>")),/LAYOUT_REVIEW_REQUIRED/);
});

test("Canpar reviewed transfer and hold codes cannot be mistaken for delivery",async()=>{
    const data={result:[{barcode:"TEST-1",delivered:false,events:[]}]};
    const reader=createPublicHttpTracking({now:()=>"2026-09-17T20:00:00Z",fetchImpl:async()=>
        new Response(JSON.stringify(data),{headers:{"content-type":"application/json"}})});
    for(const [code,description,webDescription,status] of [
        ["TRF","Handed Off to a Local Delivery Partner","Your shipment is currently in transit and is expected on","IN_TRANSIT"],
        ["INO","Handed Off to a Local Delivery Partner","Your shipment is on hold, please connect with a live agent for further updates","EXCEPTION"],
        ["HLD","Delayed at Facility","Your shipment is on hold, please connect with a live agent for further updates","EXCEPTION"]]){
        data.result[0].events=[{local_date_time:"20260917 120000",code,code_description_en:description,web_description_en:webDescription},
            {local_date_time:"20260916 120000",code:"DEL",code_description_en:"Our Package was Delivered",web_description_en:"Your shipment is delivered on"}];
        const result=await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"},{unverifiedTimeMode:"OBSERVED"});
        assert.equal(result.status,status);
        assert.equal(result.deliveredAt,null);
        data.result[0].events[0].web_description_en="Unreviewed wording";
        assert.equal((await reader.poll({carrier:"Canpar",trackingNumber:"TEST-1"},{unverifiedTimeMode:"OBSERVED"})).code,"LAYOUT_REVIEW_REQUIRED");
    }
});
