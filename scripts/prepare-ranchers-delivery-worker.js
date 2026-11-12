"use strict";
const {Client}=require("pg");
const sync=require("../shopify-tracking-sync");
const {createShopifyTrackingApi}=require("../shopify-tracking-api");
const {assertFeatures}=require("../shopify-tracking-worker");

async function main(){
    const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:20000});
    await client.connect();
    try{
        await client.query("begin");
        await client.query("set local lock_timeout='5s'");
        const result=await client.query("select * from store_integrations where id=4 and account_name=$1 and store_identifier=$2 and provider='SHOPIFY' and is_active for update",
            ["RANCHER'S CHIPS","f1acxk-dc.myshopify.com"]);
        if(result.rows.length!==1) throw Error("RANCHERS_INTEGRATION_SCOPE_MISMATCH");
        const row=result.rows[0];
        await assertFeatures(client,row.account_name);
        await createShopifyTrackingApi().verify(row);
        const counts=await client.query("select carrier_key,count(*)::int as count from shipment_trackers where account_name=$1 group by carrier_key order by carrier_key",[row.account_name]);
        console.log(JSON.stringify({mode:process.argv.includes("--apply")?"APPLY":"READ_ONLY",integrationId:row.id,carrierCounts:counts.rows}));
        if(process.argv.includes("--apply")){
            await sync.initializeSchema(client);
            await client.query(`create table if not exists shopify_tracking_worker_health(
                integration_id bigint primary key references store_integrations(id),last_cycle_at timestamptz,
                last_success_at timestamptz,last_error text not null default '',last_report jsonb not null default '{}'::jsonb)`);
            await client.query(`update store_integrations set settings=coalesce(settings,'{}'::jsonb)||
                '{"carrierFulfillmentEventsEnabled":true,"publicCarrierTrackingEnabled":true,"trackingPollMinutes":45,"trackingWindowDays":45,"carrierUnverifiedTimeMode":"HOLD"}'::jsonb
                where id=$1 and account_name=$2 and store_identifier=$3`,[row.id,row.account_name,row.store_identifier]);
            await client.query("commit");
            console.log(JSON.stringify({enabled:true,timeMode:"HOLD",inventoryChanged:false,ordersChanged:false}));
        }else await client.query("rollback");
    }catch(error){await client.query("rollback");throw error;}
    finally{await client.end();}
}
main().catch(error=>{console.error(String(error.code || error.message).replace(/[^A-Z0-9_]/g,"_").slice(0,100));process.exitCode=1;});
