"use strict";
const {Client}=require("pg");
async function main(){
    const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:20000});
    await client.connect();
    try{
        await client.query("begin");
        await client.query("set local lock_timeout='5s'");
        await client.query("set local statement_timeout='20s'");
        const result=await client.query("select * from store_integrations where id=4 for update");
        const row=result.rows[0];
        if(row?.account_name!=="RANCHER'S CHIPS" || row.store_identifier!=="f1acxk-dc.myshopify.com" || row.provider!=="SHOPIFY" || !row.is_active) throw Error("APPROVAL_SCOPE_MISMATCH");
        const existing=row.settings?.carrierObservedTimeApprovedAt;
        const approval=existing || new Date().toISOString();
        const settings={...row.settings,carrierUnverifiedTimeMode:"OBSERVED",carrierObservedTimeApprovedAt:approval,
            carrierObservedTimeApprovedBy:"k.prathab@gmail.com",carrierObservedTimeApprovalReason:"Owner explicitly approved recording time on 2026-09-17; preserve original carrier-local scan time and disclose unverified timezone."};
        await client.query("update store_integrations set settings=$1::jsonb where id=4",[JSON.stringify(settings)]);
        if(!existing) await client.query(`insert into shopify_tracking_corrections(fulfillment_binding_id,tracker_id,actor,reason,action)
            select f.id,p.tracker_id,$1,$2,'REPLAY_EVENTS' from shopify_tracking_fulfillments f
            join shopify_tracking_packages p on p.fulfillment_binding_id=f.id
            where f.integration_id=4 and f.account_name=$3`,[settings.carrierObservedTimeApprovedBy,settings.carrierObservedTimeApprovalReason,row.account_name]);
        const expedited=await client.query(`update shipment_trackers t set next_poll_at=now(),attempts=0
            where t.account_name=$1 and t.is_active and t.status<>'DELIVERED' and t.manual_closed_at is null and t.claimed_at is null
              and t.carrier_key in ('CANPAR','ICS_COURIER')
              and exists(select 1 from shopify_tracking_packages p join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id
                  where p.tracker_id=t.id and f.integration_id=4 and f.expires_at>now())`,[row.account_name]);
        await client.query("commit");
        console.log(JSON.stringify({integration:4,mode:"OBSERVED",approvedAt:approval,expedited:expedited.rowCount,otherStoresChanged:0}));
    }catch(error){await client.query("rollback");throw error;}
    finally{await client.end();}
}
main().catch(error=>{console.error(String(error.code || error.message).replace(/[^A-Z0-9_]/g,"_").slice(0,100));process.exitCode=1;});
