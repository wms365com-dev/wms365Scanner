"use strict";
const fs=require("node:fs");
const crypto=require("node:crypto");
const {Pool}=require("pg");
const {createPublicHttpTracking}=require("../carrier-public-http");
const {createShopifyTrackingApi}=require("../shopify-tracking-api");
const worker=require("../shopify-tracking-worker");
const sync=require("../shopify-tracking-sync");
async function main(){
    const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:20000,
        options:"-c search_path=wms365_tracking_4,public,pg_catalog"});
    try{
        const row=(await pool.query("select * from store_integrations where id=4")).rows[0];
        if(row?.account_name!=="RANCHER'S CHIPS" || row.store_identifier!=="f1acxk-dc.myshopify.com"
            || row.settings?.carrierUnverifiedTimeMode!=="OBSERVED" || !row.settings?.carrierObservedTimeApprovedAt) throw Error("ACCEPTANCE_SCOPE_MISMATCH");
        const audit=JSON.parse(fs.readFileSync(".codex-tmp/ranchers-carrier-delivery-evidence-20260917.json","utf8"));
        if(audit.accountName!==row.account_name || audit.mode!=="READ_ONLY") throw Error("CANDIDATE_SCOPE_MISMATCH");
        const reader=createPublicHttpTracking();
        const api=createShopifyTrackingApi();
        await worker.assertFeatures(pool,row.account_name);
        await api.verify(row);
        const accepted=[];
        for(const carrier of ["CANPAR","ICS_COURIER"]){
            const numbers=audit.packages.filter((p)=>p.carrier===(carrier==="ICS_COURIER" ? "ICS" : carrier)
                && p.evidence?.status==="DELIVERED").map((p)=>p.number);
            const candidates=await pool.query(`select t.*,f.integration_id,f.fulfillment_gid,f.enrolled_at,f.expires_at,f.tracking_poll_minutes,i.settings as integration_settings
                from shipment_trackers t join shopify_tracking_packages p on p.tracker_id=t.id and p.account_name=t.account_name
                join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id and f.order_id=t.order_id and f.account_name=t.account_name
                join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name
                where i.id=4 and t.account_name=$1 and t.carrier_key=$2 and t.tracking_number=any($3::text[])
                  and t.status<>'DELIVERED' and t.manual_closed_at is null and t.claimed_at is null and f.expires_at>now()
                order by t.id limit 3`,[row.account_name,carrier,numbers]);
            for(const tracker of candidates.rows){
                const result=await reader.poll({carrier:tracker.carrier_name,trackingNumber:tracker.tracking_number},{unverifiedTimeMode:"OBSERVED"});
                if(!result.ok || result.status!=="DELIVERED"){console.log(JSON.stringify({carrier,held:result.code || "NOT_DELIVERED"}));continue;}
                const claim=crypto.randomUUID();
                const claimed=await worker.transaction(pool,async(client)=>client.query(`update shipment_trackers set claimed_by=$2,claimed_at=now()
                    where id=$1 and account_name=$3 and claimed_at is null and manual_closed_at is null and status<>'DELIVERED' returning id`,[tracker.id,claim,row.account_name]));
                if(!claimed.rows.length) continue;
                await worker.storeScan(pool,tracker,result,claim);
                accepted.push({carrier,fulfillmentId:tracker.fulfillment_gid});
                break;
            }
        }
        for(let n=0;n<20;n++){
            const outcome=await worker.transaction(pool,(client)=>sync.processOne(client,{request:api.request,assertFeatures:worker.assertFeatures,integrationId:4}));
            if(!outcome) break;
        }
        for(const acceptedRow of accepted){
            const result=await api.request(row,"/graphql.json",{body:{query:`{fulfillment(id:${JSON.stringify(acceptedRow.fulfillmentId)}) {displayStatus deliveredAt events(first:100) {nodes {status happenedAt message}}}}`}});
            const remote=result.payload.data.fulfillment;
            const delivered=remote.events.nodes.find((e)=>e.status==="DELIVERED");
            console.log(JSON.stringify({carrier:acceptedRow.carrier,shopifyStatus:remote.displayStatus,deliveredAt:remote.deliveredAt,
                recordedTimeNotePresent:delivered?.message?.includes("recording time, not actual delivery time")===true,
                originalLocalTimePresent:/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(delivered?.message || "")}));
        }
        if(!accepted.length) console.log(JSON.stringify({accepted:0,reason:"CANDIDATES_ALREADY_CLAIMED_OR_PROCESSED"}));
    }finally{await pool.end();}
}
main().catch(error=>{console.error(String(error.code || error.message).replace(/[^A-Z0-9_]/g,"_").slice(0,100));process.exitCode=1;});
