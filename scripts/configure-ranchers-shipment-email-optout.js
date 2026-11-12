"use strict";
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";

async function scope(client) {
    const rows = await client.query(`select i.id,i.account_name,i.store_identifier,i.is_active,i.settings
        from store_integrations i join owner_accounts a on a.name=i.account_name and a.is_active
        where i.id=4 and i.account_name=$1 and i.store_identifier=$2 and i.provider='SHOPIFY' and i.is_active`, [ACCOUNT,STORE]);
    if (rows.rows.length !== 1) throw Error("EMAIL_POLICY_SCOPE_MISMATCH");
    return rows.rows[0];
}

async function verify(client) {
    const integration = await scope(client);
    const preference = await client.query(`select is_subscribed from customer_email_preferences
        where account_name=$1 and email='*' and notification_type='SHIPMENT_CONFIRMATION'`, [ACCOUNT]);
    const queue = await client.query(`select shipment_email_status,count(*)::int as count from portal_orders
        where account_name=$1 and shipment_email_status in ('SCHEDULED','SENDING','FAILED') group by shipment_email_status`, [ACCOUNT]);
    const installed = await client.query(`select count(*)::int as count from pg_trigger
        where tgrelid='public.portal_orders'::regclass and tgname='wms365_shipment_email_preference_guard' and tgenabled='O'`);
    return { account:ACCOUNT, individualShipmentEmailsEnabled:preference.rows[0]?.is_subscribed !== false,
        queuedEmails:queue.rows, guardInstalled:installed.rows[0].count===1,
        shopifySettings: { syncShipmentConfirmations:integration.settings?.syncShipmentConfirmations,
            notifyCustomerOnFulfillment:integration.settings?.notifyCustomerOnFulfillment,
            carrierFulfillmentEventsEnabled:integration.settings?.carrierFulfillmentEventsEnabled,
            publicCarrierTrackingEnabled:integration.settings?.publicCarrierTrackingEnabled } };
}

async function testPolicy(client, sql) {
    const company = await requireDesignatedTestCompany(client);
    await client.query(`create temporary table email_policy_fixture (
        id serial primary key,account_name text not null,status text not null default 'DRAFT',
        shipment_email_status text not null default '',shipment_email_scheduled_at timestamptz,
        shipment_email_last_error text not null default '') on commit drop`);
    const fixtureSql = sql.replaceAll('public.portal_orders','pg_temp.email_policy_fixture')
        .replaceAll('public.wms365_shipment_email_subscribed','pg_temp.wms365_shipment_email_subscribed')
        .replaceAll('public.wms365_guard_shipment_email_queue','pg_temp.wms365_guard_shipment_email_queue');
    await client.query(fixtureSql);
    await client.query(`insert into customer_email_preferences(account_name,email,notification_type,is_subscribed)
        values($1,'*','SHIPMENT_CONFIRMATION',false)
        on conflict(account_name,email,notification_type) do update set is_subscribed=false`, [company.name]);
    const inserted = (await client.query(`insert into pg_temp.email_policy_fixture(account_name,status,shipment_email_status,shipment_email_scheduled_at)
        values($1,'SHIPPED','SCHEDULED',now()) returning *`, [company.name])).rows[0];
    assert.equal(inserted.shipment_email_status,'SKIPPED');
    assert.equal(inserted.shipment_email_scheduled_at,null);
    const claimed = await client.query("update pg_temp.email_policy_fixture set shipment_email_status='SENDING' where id=$1 returning id",[inserted.id]);
    assert.equal(claimed.rowCount,0);
    assert.equal((await client.query("update pg_temp.email_policy_fixture set status='STAGED' where id=$1 returning status",[inserted.id])).rows[0].status,'STAGED');
    await client.query("update customer_email_preferences set is_subscribed=true where account_name=$1 and email='*' and notification_type='SHIPMENT_CONFIRMATION'",[company.name]);
    const allowed = await client.query("update pg_temp.email_policy_fixture set shipment_email_status='SCHEDULED' where id=$1 returning shipment_email_status",[inserted.id]);
    assert.equal(allowed.rows[0].shipment_email_status,'SCHEDULED');
    assert.equal((await client.query("update pg_temp.email_policy_fixture set shipment_email_status='SENDING' where id=$1 returning id",[inserted.id])).rowCount,1);
    return { testCompany:company.name, assertions:6, temporaryFixturesOnly:true, rolledBack:true, emailsSent:0 };
}

async function main(args=[],sql) {
    const mode=args[0] || '--verify';
    if (args.length>1 || !['--test','--apply','--verify'].includes(mode)) throw Error("EMAIL_POLICY_MODE_INVALID");
    if (!sql || !process.env.DATABASE_URL) throw Error("EMAIL_POLICY_CONFIGURATION_REQUIRED");
    const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:20000});
    await client.connect();
    try {
        await client.query(mode==='--verify' ? 'begin read only' : 'begin');
        await client.query("set local lock_timeout='5s'");
        await client.query("set local statement_timeout='20s'");
        let result;
        if(mode==='--test') result=await testPolicy(client,sql);
        else {
            const before=await scope(client);
            if(mode==='--apply') {
                await client.query('lock table public.portal_orders in share row exclusive mode');
                const sending=await client.query("select count(*)::int as count from portal_orders where account_name=$1 and shipment_email_status='SENDING'",[ACCOUNT]);
                if(sending.rows[0].count!==0) throw Error("EMAIL_POLICY_SEND_IN_PROGRESS_REVIEW_REQUIRED");
                await client.query(sql);
                await client.query(`insert into customer_email_preferences(account_name,email,notification_type,is_subscribed,unsubscribed_at,unsubscribe_source,updated_at)
                    values($1,'*','SHIPMENT_CONFIRMATION',false,now(),'owner_requested_company_optout',now())
                    on conflict(account_name,email,notification_type) do update set is_subscribed=false,
                    unsubscribed_at=coalesce(customer_email_preferences.unsubscribed_at,now()),unsubscribe_source=excluded.unsubscribe_source,updated_at=now()`,[ACCOUNT]);
                const skipped=await client.query(`update portal_orders set shipment_email_status='SKIPPED',shipment_email_scheduled_at=null,
                    shipment_email_last_error='Company opted out of individual shipment confirmations.'
                    where account_name=$1 and shipment_email_status in ('SCHEDULED','FAILED') returning id`,[ACCOUNT]);
                await client.query("insert into activity_log(type,title,details) values('email','Company shipment confirmation emails disabled',$1)",
                    [`${ACCOUNT} | Company-wide per-order opt-out requested by owner following Logan's request. Shopify buyer notifications and tracking unchanged. Daily summary not enabled.`]);
                result={cancelledQueuedEmails:skipped.rowCount};
            }
            result={...result,...await verify(client)};
            assert.deepEqual((await scope(client)).settings,before.settings);
            if(mode==='--apply') {
                assert.equal(result.individualShipmentEmailsEnabled,false);
                assert.equal(result.guardInstalled,true);
                assert.deepEqual(result.queuedEmails,[]);
            }
        }
        await client.query(mode==='--apply'?'commit':'rollback');
        const output={generatedAt:new Date().toISOString(),mode,...result};
        console.log(JSON.stringify(output));
        return output;
    }catch(error){await client.query('rollback');throw error;}
    finally{await client.end();}
}

module.exports={main,scope,verify,testPolicy};
