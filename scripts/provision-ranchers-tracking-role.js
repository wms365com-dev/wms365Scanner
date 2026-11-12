"use strict";
const {Client}=require("pg");

async function main(){
    const password=process.env.TRACKING_DB_PASSWORD;
    if(!/^[a-f0-9]{64}$/.test(password || "")) throw Error("SECURE_WORKER_PASSWORD_REQUIRED");
    const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:20000});
    await client.connect();
    try{
        await client.query("begin");
        await client.query("set local lock_timeout='5s'");
        await client.query("set local statement_timeout='20s'");
        const role="wms365_tracking_4";
        const existing=await client.query("select rolname from pg_roles where rolname=$1",[role]);
        if(existing.rows.length) throw Error("TRACKING_ROLE_ALREADY_EXISTS_REVIEW_REQUIRED");
        await client.query(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
        await client.query(`create schema ${role}`);
        await client.query(`grant usage on schema ${role} to ${role}`);
        const read={store_integrations:"id=4 and account_name='RANCHER''S CHIPS' and store_identifier='f1acxk-dc.myshopify.com'",
            owner_accounts:"name='RANCHER''S CHIPS'",portal_orders:"account_name='RANCHER''S CHIPS'",
            store_order_imports:"integration_id=4",warehouse_shipments:"account_name='RANCHER''S CHIPS'"};
        const write={shipment_trackers:"account_name='RANCHER''S CHIPS'",shipment_tracking_events:
            "tracker_id in (select id from public.shipment_trackers where account_name='RANCHER''S CHIPS')",
            shopify_tracking_fulfillments:"integration_id=4 and account_name='RANCHER''S CHIPS'",
            shopify_tracking_packages:"account_name='RANCHER''S CHIPS' and fulfillment_binding_id in(select id from public.shopify_tracking_fulfillments where integration_id=4)",
            shopify_tracking_outbox:"fulfillment_binding_id in(select id from public.shopify_tracking_fulfillments where integration_id=4)",
            shopify_tracking_corrections:"fulfillment_binding_id in(select id from public.shopify_tracking_fulfillments where integration_id=4)",
            shopify_tracking_worker_health:"integration_id=4"};
        for(const [table,where] of Object.entries({...read,...write})){
            if(write[table]){
                const existingPolicy=await client.query("select relrowsecurity from pg_class where oid=$1::regclass",[`public.${table}`]);
                if(existingPolicy.rows[0]?.relrowsecurity) throw Error("EXISTING_ROW_SECURITY_REVIEW_REQUIRED");
                await client.query(`alter table public.${table} enable row level security`);
                // Existing table permissions and all existing users retain their prior behavior.
                await client.query(`create policy tracking_existing_users on public.${table} to public using(current_user<>'${role}') with check(current_user<>'${role}')`);
                await client.query(`create policy tracking_ranchers_worker on public.${table} to ${role} using(${where}) with check(${where})`);
                await client.query(`grant select,insert,update on public.${table} to ${role}`);
                const seq=table==="shopify_tracking_worker_health" ? {rows:[]} : await client.query("select pg_get_serial_sequence($1,'id') as name",[`public.${table}`]);
                if(seq.rows[0]?.name) await client.query(`grant usage,select on sequence ${seq.rows[0].name} to ${role}`);
            }else{
                await client.query(`create view ${role}.${table} with(security_barrier=true) as select * from public.${table} where ${where} with local check option`);
                await client.query(`grant select on ${role}.${table} to ${role}`);
                if(table==="store_integrations") await client.query(`grant update(id) on ${role}.${table} to ${role}`);
            }
        }
        // Events and administrative corrections stay immutable for the worker.
        await client.query(`revoke update on public.shipment_tracking_events,public.shopify_tracking_corrections from ${role}`);
        await client.query(`alter role ${role} set search_path=${role},public,pg_catalog`);
        await client.query(`alter role ${role} set lock_timeout='5s'`);
        await client.query(`alter role ${role} set idle_in_transaction_session_timeout='120s'`);
        await client.query("commit");
        console.log(JSON.stringify({role,scope:"RANCHERS_TRACKING_ONLY",orderWrites:false,inventoryWrites:false,billingWrites:false}));
    }catch(error){await client.query("rollback");throw error;}
    finally{await client.end();}
}
main().catch(error=>{console.error(String(error.code || error.message).replace(/[^A-Z0-9_]/g,"_").slice(0,100));process.exitCode=1;});
