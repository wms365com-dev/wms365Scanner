"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const sync = require("./shopify-tracking-sync");
const { createShopifyTrackingApi } = require("./shopify-tracking-api");
const { parseOffsetTimestamp } = require("./carrier-public-tracking");
const { normalizeTrackingCarrier } = require("./carrier-tracking");
const WORKER_REVISION = "carrier-resilience-20260918-v6";
const SAFE_ERRORS = new Set(["LAYOUT_REVIEW_REQUIRED","PAYLOAD_LIMIT","TRACKING_ID_MISMATCH","TIMEZONE_REQUIRED",
    "NO_PHYSICAL_SCAN","SCAN_CONFLICT","PIECE_REVIEW_REQUIRED","INVALID_SCAN_TIME","INVALID_OBSERVATION_TIME",
    "CARRIER_RATE_LIMITED","CARRIER_UNAVAILABLE","CARRIER_HTTP_FAILED","CARRIER_HTTP_READ_FAILED",
    "CARRIER_BROWSER_FAILED","CARRIER_READ_FAILED","TIMEOUT","BROWSER_UNAVAILABLE","CARRIER_BUSY","RATE_LIMITED",
    "RESOURCE_CLOSE_FAILED","CARRIER_TIME_BASIS_UNVERIFIED","CARRIER_SCAN_UNVERIFIED","OBSERVED_TIME_NOT_APPROVED",
    "CARRIER_SOURCE_UNRECOGNIZED","CARRIER_IDENTITY_MISMATCH","REMOTE_OWNERSHIP_MISMATCH",
    "REMOTE_FULFILLMENTS_INCOMPLETE","REMOTE_TRACKING_IDENTITY_MISSING","SHOPIFY_TRACKING_REQUEST_FAILED",
    "TRACKING_PROCESSING_FAILED","CARRIER_CHECK_FAILED","SHOPIFY_DISCOVERY_FAILED","TRACKING_CYCLE_FAILED",
    "WORKER_CONFIGURATION_REQUIRED","WORKER_SCHEMA_INVALID","WORKER_BATCH_LIMIT_INVALID","WORKER_TIME_BUDGET_INVALID",
    "WORKER_CARRIER_SCOPE_INVALID","TRACKING_STORE_NOT_ENABLED","COMPANY_FEATURE_SCOPE_MISSING","COMPANY_INTEGRATION_DISABLED",
    "HISTORY_APPROVAL_ACTOR_REQUIRED","CARRIER_EVENT_IDENTITY_MISSING","INTEGRATION_KEY_REQUIRED",
    "INVALID_ENCRYPTED_CREDENTIAL","STORE_HOST_RESTRICTED","SHOPIFY_AUTH_UNAVAILABLE","TRACKING_API_PATH_RESTRICTED",
    "SHOPIFY_STORE_OWNERSHIP_MISMATCH","WRITE_FULFILLMENTS_REQUIRED"]);
function safeError(error, fallback = "TRACKING_PROCESSING_FAILED") {
    const code = error?.code || error?.message;
    return SAFE_ERRORS.has(code) ? code : fallback;
}
function retryCheckAt(attempts, checkedAt, delay) {
    const exponential = new Date(sync.retryAt(attempts, checkedAt)).getTime();
    const requested = Number.isFinite(delay) && delay>0 ? Math.min(delay,86400000) : 0;
    return new Date(Math.max(exponential,new Date(checkedAt).getTime()+requested)).toISOString();
}

function trackingWarning(report) {
    if (!report) return "TRACKING_NOT_CHECKED";
    const polling = report.polling;
    return polling.failed || report.failed || report.unresolved || report.discovery?.failed
        ? `TRACKING_CHECK_FAILURES_${polling.failed}_SHOPIFY_FAILURES_${report.failed}_UNRESOLVED_${report.unresolved || 0}_DISCOVERY_FAILURES_${report.discovery?.failed || 0}` : "";
}

function trackingHealth({ running, heartbeat, latestReport, lastCycleFailed, lastSuccessAt }, now = Date.now()) {
    const healthy = running && now - heartbeat < 30 * 60000;
    const warning = lastCycleFailed ? "TRACKING_CYCLE_FAILED" : trackingWarning(latestReport);
    return { healthy, revision: WORKER_REVISION,
        quality: warning ? (latestReport || lastCycleFailed ? "DEGRADED" : "STARTING") : "OK",
        warning, lastSuccessAt,
        tracking: latestReport ? { ...latestReport.polling, shopifyFailures: latestReport.failed,
            unresolved: latestReport.unresolved || 0, discoveryFailures: latestReport.discovery?.failed || 0 } : null };
}

async function unresolvedChecks(pool, integrationId) {
    const result = await pool.query(`select count(distinct t.id)::int as count
        from shipment_trackers t join shopify_tracking_packages p on p.tracker_id=t.id and p.account_name=t.account_name
          and p.order_id=t.order_id and p.fulfillment_location_id=t.fulfillment_location_id and p.warehouse_shipment_id=t.warehouse_shipment_id
        join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id and f.account_name=p.account_name and f.order_id=p.order_id
        join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name and i.store_identifier=f.store_identifier
        where i.id=$1 and i.is_active and i.settings->>'publicCarrierTrackingEnabled'='true'
          and i.settings->>'carrierFulfillmentEventsEnabled'='true' and f.enrolled_at is not null
          and f.expires_at>now() and t.is_active and t.manual_closed_at is null and t.status<>'DELIVERED'
          and t.carrier_key=any($2::text[]) and t.last_error<>''`,
        [integrationId, ["CANPAR", "ICS_COURIER", "GLS", "GLS_GROUND"]]);
    return result.rows[0].count;
}

const ORDER_QUERY = `query TrackingOrder($id: ID!) {
    shop { id name myshopifyDomain }
    order(id:$id) { id name fulfillmentsCount { count } fulfillments(first:100) {
        id status displayStatus deliveredAt trackingInfo { company number url }
    } }
}`;

function canTrack(row) {
    return row?.is_active === true && row.provider === "SHOPIFY"
        && row.settings?.carrierFulfillmentEventsEnabled === true
        && row.settings?.publicCarrierTrackingEnabled === true;
}

function validateRemote(row, order, data) {
    const id = `gid://shopify/Order/${String(order.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "")}`;
    if (data.shop?.myshopifyDomain !== row.store_identifier || data.order?.id !== id) throw new Error("REMOTE_OWNERSHIP_MISMATCH");
    const list = data.order.fulfillments;
    if (!Array.isArray(list) || !Number.isInteger(data.order.fulfillmentsCount?.count)
        || data.order.fulfillmentsCount.count !== list.length) throw new Error("REMOTE_FULFILLMENTS_INCOMPLETE");
    return list.filter((f) => f.status !== "CANCELLED" && f.status !== "FAILURE"
        && f.displayStatus !== "DELIVERED" && !f.deliveredAt && f.trackingInfo?.length);
}

async function assertFeatures(client, account) {
    const result = await client.query("select feature_flags from owner_accounts where name=$1", [account]);
    if (result.rows.length !== 1) throw new Error("COMPANY_FEATURE_SCOPE_MISSING");
    const flags = result.rows[0].feature_flags;
    // Existing legacy accounts use the platform's legacy integration defaults.
    if (flags && (flags.STORE_INTEGRATIONS !== true || flags.SHOPIFY_INTEGRATION !== true)) throw new Error("COMPANY_INTEGRATION_DISABLED");
}

async function transaction(pool, fn) {
    const client = await pool.connect();
    try { await client.query("begin"); await client.query("set local lock_timeout='5s'");
        await client.query("set local idle_in_transaction_session_timeout='120s'");
        const value = await fn(client); await client.query("commit"); return value; }
    catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
}

async function approveHistory(client, binding, actor) {
    if (!String(actor || "").trim()) throw new Error("HISTORY_APPROVAL_ACTOR_REQUIRED");
    await client.query("select id from shopify_tracking_fulfillments where id=$1 for update", [binding.id]);
    await client.query(`insert into shopify_tracking_corrections(fulfillment_binding_id,tracker_id,actor,reason,action)
        select $1,p.tracker_id,$2,'Owner approved historical delivery reconciliation; fresh carrier evidence required.','REPLAY_EVENTS'
        from shopify_tracking_packages p where p.fulfillment_binding_id=$1
        and not exists(select 1 from shopify_tracking_fulfillments f where f.id=$1 and f.historical_delivery_approved_at is not null)`, [binding.id, actor.slice(0, 180)]);
    await client.query("update shopify_tracking_fulfillments set historical_delivery_approved_at=coalesce(historical_delivery_approved_at,now()) where id=$1", [binding.id]);
}

async function discover(pool, row, api, { approveHistorical = false, actor = "", onProgress = () => {} } = {}) {
    const orders = await pool.query(`select o.id,o.order_code,o.account_name,o.shipped_at,imp.external_order_id from portal_orders o
        join store_order_imports imp on imp.portal_order_id=o.id and imp.integration_id=$1
        join store_integrations i on i.id=imp.integration_id and i.account_name=o.account_name
        where o.account_name=$2 and o.status='SHIPPED' and i.is_active
          and o.shipped_at>=now()-($3 * interval '1 day')
          and exists (select 1 from shipment_trackers t where t.order_id=o.id and t.account_name=o.account_name)
        order by o.shipped_at,o.id limit 2000`, [row.id, row.account_name, sync.deliverySettings(row).trackingWindowDays]);
    let bound = 0;
    let failed = 0;
    const errors = {};
    for (const order of orders.rows) {
        onProgress();
        try {
        const id = `gid://shopify/Order/${String(order.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "")}`;
        const result = await api.request(row, "/graphql.json", { body: { query: ORDER_QUERY, variables: { id } } });
        for (const f of validateRemote(row, order, result.payload.data)) {
            const expected = f.trackingInfo.map((t) => t.number);
            if (expected.some((n) => !n || typeof n !== "string")) throw new Error("REMOTE_TRACKING_IDENTITY_MISSING");
            await transaction(pool, async (client) => {
                await assertFeatures(client, row.account_name);
                const binding = await sync.bindFulfillment(client, row, { id: order.id, accountName: order.account_name },
                    order.external_order_id, f, expected, { id: result.payload.data.shop.id, name: result.payload.data.shop.name });
                if (binding && approveHistorical && (!process.env.TRACKING_HISTORY_CUTOFF || new Date(order.shipped_at)<=new Date(process.env.TRACKING_HISTORY_CUTOFF))) await approveHistory(client, binding, actor);
            });
            bound += 1;
        }
        } catch (error) {
            failed += 1;
            const code = safeError(error,"SHOPIFY_DISCOVERY_FAILED");
            errors[code] = (errors[code] || 0) + 1;
        }
    }
    return { orders: orders.rows.length, bound, failed, errors };
}

function scanEvent(row, result, checkedAt) {
    if (normalizeTrackingCarrier(row.carrier_name) !== result.carrier) throw new Error("CARRIER_IDENTITY_MISMATCH");
    const date = parseOffsetTimestamp(result.eventAt)?.eventAt;
    if(!["CARRIER_OFFSET_TIMESTAMP","OBSERVED_CONFIRMED_STATUS"].includes(result.timeBasis)) throw new Error("CARRIER_TIME_BASIS_UNVERIFIED");
    if (!result.ok || (!sync.STATUS_MAP[result.status] && result.status !== "LABEL_CREATED") || !date
        || !parseOffsetTimestamp(checkedAt) || new Date(date)>new Date(checkedAt)) throw new Error("CARRIER_SCAN_UNVERIFIED");
    if (result.timeBasis === "OBSERVED_CONFIRMED_STATUS") {
        const approval=parseOffsetTimestamp(row.integration_settings?.carrierObservedTimeApprovedAt)?.eventAt;
        if (row.integration_settings?.carrierUnverifiedTimeMode !== "OBSERVED" || !approval
            || new Date(approval)>new Date(date) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(result.carrierLocalTimestamp || "")) throw new Error("OBSERVED_TIME_NOT_APPROVED");
    }
    const source = { GLS: "GLS_BROWSER", CANPAR: "CANPAR_BROWSER", ICS_COURIER: "ICS_COURIER_BROWSER" }[result.carrier];
    if (!source) throw new Error("CARRIER_SOURCE_UNRECOGNIZED");
    const metadata = { carrier_scan: true, checked_at: checkedAt, time_basis: result.timeBasis,
        carrier_local_timestamp: result.carrierLocalTimestamp || "", layout_version: result.layoutVersion || "",
        observed_time_approved_at: result.timeBasis === "OBSERVED_CONFIRMED_STATUS" ? row.integration_settings.carrierObservedTimeApprovedAt : null };
    const identityTime=result.timeBasis === "OBSERVED_CONFIRMED_STATUS" ? `OBSERVED:${result.carrierLocalTimestamp}` : date;
    const eventKey = crypto.createHash("sha256").update(`${row.tracking_number}:${result.status}:${identityTime}:${result.carrierLocalTimestamp || ""}`).digest("hex");
    return { eventKey, source, metadata, at: new Date(date).toISOString() };
}

async function storeScan(pool, row, result, claim, checkedAt = new Date().toISOString()) {
    return transaction(pool, async (client) => {
        const current = await client.query(`select t.* from shipment_trackers t
            join warehouse_shipments s on s.id=t.warehouse_shipment_id and s.order_id=t.order_id
              and s.account_name=t.account_name and s.fulfillment_location_id=t.fulfillment_location_id
            join portal_orders o on o.id=t.order_id and o.account_name=t.account_name
            where t.id=$1 and t.claimed_by=$2 and t.tracking_number=$3 and t.carrier_name=$4
              and s.status='SHIPPED' and o.status='SHIPPED' and t.manual_closed_at is null
              and t.is_active and t.status<>'DELIVERED' for update of t`,
            [row.id, claim, row.tracking_number, row.carrier_name]);
        if (current.rows.length !== 1) return false;
        await assertFeatures(client, row.account_name);
        const enabled = await client.query("select * from store_integrations where id=$1 and account_name=$2 for share", [row.integration_id, row.account_name]);
        if (!canTrack(enabled.rows[0])) return false;
        if (!result.ok) {
            const attempts = Number(current.rows[0].attempts) + 1;
            await client.query(`update shipment_trackers set attempts=$2,last_checked_at=$3,last_error=$4,
                next_poll_at=$5,claimed_by='',claimed_at=null,updated_at=now() where id=$1`, [row.id, attempts, checkedAt,
                safeError({code:result.code || result.error},"CARRIER_CHECK_FAILED"), retryCheckAt(attempts, checkedAt,result.retryAfterMs)]);
            return false;
        }
        const event = scanEvent({...row,integration_settings:enabled.rows[0].settings}, result, checkedAt);
        const inserted=await client.query(`insert into shipment_tracking_events(tracker_id,event_key,status,raw_status_code,description,location,event_at,source,safe_metadata)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict(tracker_id,event_key) do nothing returning event_at`,
            [row.id, event.eventKey, result.status, result.rawStatusCode || "", result.description || result.status,
                result.location || "", event.at, event.source, JSON.stringify(event.metadata)]);
        if (!inserted.rows.length) {
            const existing=await client.query("select event_at from shipment_tracking_events where tracker_id=$1 and event_key=$2",[row.id,event.eventKey]);
            if(existing.rows.length!==1) throw new Error("CARRIER_EVENT_IDENTITY_MISSING");
            event.at=new Date(existing.rows[0].event_at).toISOString();
        }
        const binding = { enrolled_at: row.enrolled_at, expires_at: row.expires_at, tracking_poll_minutes: row.tracking_poll_minutes };
        if (current.rows[0].last_event_at && new Date(current.rows[0].last_event_at)>new Date(event.at)) {
            await client.query(`update shipment_trackers set last_checked_at=$2,next_poll_at=$3,
                attempts=0,last_error='',claimed_by='',claimed_at=null,updated_at=now() where id=$1`,
                [row.id,checkedAt,sync.enrolledPollAt(binding,current.rows[0].status,checkedAt)]);
            return false;
        }
        const next = sync.enrolledPollAt(binding, result.status, checkedAt);
        await client.query(`update shipment_trackers set status=$2,status_detail=$3,last_event_at=$4,last_checked_at=$5,
            delivered_at=case when $2='DELIVERED' and $7='CARRIER_OFFSET_TIMESTAMP' then $4::timestamptz else null end, next_poll_at=$6,
            is_active=$6::timestamptz is not null,attempts=0,last_error='',claimed_by='',claimed_at=null,updated_at=now()
            where id=$1 and (last_event_at is null or last_event_at<=$4::timestamptz)`,
            [row.id,result.status,result.status,event.at,checkedAt,next,result.timeBasis]);
        await sync.queueTrackerEvents(client, row.id);
        return true;
    });
}

async function pollDue(pool, integrationId, reader, { limit = 250, carriers = ["CANPAR","ICS_COURIER","GLS"], onConfirmed=async()=>{},
    wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms)), onProgress=()=>{}, clock=()=>performance.now(), timeBudgetMs=600000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>250 || typeof wait!=="function") throw new Error("WORKER_BATCH_LIMIT_INVALID");
    if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs<30000 || timeBudgetMs>1200000) throw new Error("WORKER_TIME_BUDGET_INVALID");
    if (!carriers.length || carriers.some((c)=>!["CANPAR","ICS_COURIER","GLS"].includes(c))) throw new Error("WORKER_CARRIER_SCOPE_INVALID");
    const storedCarriers=carriers.includes("GLS") ? [...carriers,"GLS_GROUND"] : carriers;
    const claim = crypto.randomUUID();
    const rows = await transaction(pool, async (client) => {
        const due = await client.query(`select t.*,f.integration_id,f.enrolled_at,f.expires_at,f.tracking_poll_minutes,i.settings as integration_settings
            from shipment_trackers t join shopify_tracking_packages p on p.tracker_id=t.id and p.account_name=t.account_name
              and p.order_id=t.order_id and p.fulfillment_location_id=t.fulfillment_location_id and p.warehouse_shipment_id=t.warehouse_shipment_id
            join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id and f.account_name=p.account_name and f.order_id=p.order_id
            join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name and i.store_identifier=f.store_identifier
            where i.id=$1 and i.is_active and i.settings->>'publicCarrierTrackingEnabled'='true'
              and i.settings->>'carrierFulfillmentEventsEnabled'='true' and f.enrolled_at is not null
              and f.expires_at>now() and t.is_active and t.manual_closed_at is null and t.status<>'DELIVERED'
              and t.carrier_key=any($3::text[])
              and (t.next_poll_at is null or t.next_poll_at<=now())
              and (t.claimed_at is null or t.claimed_at<now()-interval '30 minutes')
            order by t.next_poll_at nulls first,t.id for update of t skip locked limit $2`, [integrationId, limit, storedCarriers]);
        for (const row of due.rows) await client.query("update shipment_trackers set claimed_by=$2,claimed_at=now() where id=$1", [row.id, claim]);
        return due.rows;
    });
    let confirmed = 0;
    let failed = 0;
    let checked = 0;
    const errors = {};
    const started = clock();
    try { for (const row of rows) {
        if (clock()-started>=timeBudgetMs) break;
        onProgress();
        checked += 1;
        let result;
        try {
            result = await reader.poll({carrier:row.carrier_name,trackingNumber:row.tracking_number}, { unverifiedTimeMode: row.integration_settings?.carrierUnverifiedTimeMode || "HOLD" });
            if (!result || typeof result.ok!=="boolean") throw Error("CARRIER_CHECK_FAILED");
            if (result.ok) scanEvent(row,result,new Date().toISOString());
        } catch (error) { result = { ok: false, code: safeError(error,"CARRIER_BROWSER_FAILED") }; }
        let stored;
        try { stored = await storeScan(pool,row,result,claim,new Date().toISOString()); }
        catch (error) {
            result = { ok:false,code:safeError(error) };
            // Roll back the bad scan, then persist a scoped retry without its payload.
            stored = await storeScan(pool,row,result,claim,new Date().toISOString());
        }
        if (!result.ok) {
            failed += 1;
            const code = safeError({code:result.code || result.error},"CARRIER_CHECK_FAILED");
            const key = `${row.carrier_key}:${code}`;
            errors[key] = (errors[key] || 0) + 1;
        }
        if (stored) { confirmed += 1; await onConfirmed(); }
        await wait(5000);
    } } finally {
        // Release only this batch's surviving claims, including unprocessed rows.
        if (rows.length) await transaction(pool,(client)=>client.query(
            "update shipment_trackers set claimed_by='',claimed_at=null where claimed_by=$1 and id=any($2::bigint[])",
            [claim,rows.map(row=>row.id)]));
    }
    return { checked, confirmed, failed, errors, ...(checked<rows.length ? {deferred:rows.length-checked} : {}) };
}

async function runCycle(pool, integrationId, { api, reader, approveHistorical = false, actor = "", discoverOrders = true, limit = 250, carriers, onProgress=()=>{} } = {}) {
    const gate = await pool.query("select * from store_integrations where id=$1", [integrationId]);
    const row = gate.rows[0];
    if (!canTrack(row)) throw new Error("TRACKING_STORE_NOT_ENABLED");
    await assertFeatures(pool,row.account_name);
    await api.verify(row);
    const report = { discovery: discoverOrders ? await discover(pool, row, api, { approveHistorical, actor, onProgress }) : null,
        polling: null, sent: 0, failed: 0 };
    const publish=async()=>{
        const result=await transaction(pool,(client)=>sync.processOne(client,{request:api.request,assertFeatures,integrationId}));
        if(result){if(result.state==="SENT") report.sent+=1;else report.failed+=1;}
        return result;
    };
    report.polling=await pollDue(pool,integrationId,reader,{limit,carriers,onConfirmed:publish,onProgress});
    for (let count = 0; count < 500; count += 1) {
        const result = await publish();
        if (!result) break;
    }
    report.unresolved = await unresolvedChecks(pool, integrationId);
    return report;
}

async function main() {
    const integrationId = Number(process.env.TRACKING_INTEGRATION_ID);
    if (!Number.isSafeInteger(integrationId) || integrationId<1 || !process.env.DATABASE_URL) throw new Error("WORKER_CONFIGURATION_REQUIRED");
    if (process.env.TRACKING_DB_SCHEMA && !/^[a-z][a-z0-9_]{0,62}$/.test(process.env.TRACKING_DB_SCHEMA)) throw new Error("WORKER_SCHEMA_INVALID");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 20000,
        options:process.env.TRACKING_DB_SCHEMA ? `-c search_path=${process.env.TRACKING_DB_SCHEMA},public,pg_catalog` : undefined });
    const browserFallback=process.env.TRACKING_BROWSER_ENABLED==="true"
        ? require("./carrier-public-tracking").createPublicCarrierTracking({ diagnosticDir: process.env.TRACKING_DIAGNOSTIC_DIR }) : null;
    const reader = require("./carrier-public-http").createPublicHttpTracking({browserFallback});
    const api = createShopifyTrackingApi();
    let running = true;
    let lastDiscovery=0;
    let heartbeat=Date.now();
    let latestReport=null;
    let lastCycleFailed=false;
    let lastSuccessAt=null;
    console.log(JSON.stringify({revision:WORKER_REVISION,integrationId}));
    const healthServer=process.argv.includes("--once") ? null : require("node:http").createServer((_req,res)=>{
        const health=trackingHealth({running,heartbeat,latestReport,lastCycleFailed,lastSuccessAt});
        res.writeHead(health.healthy?200:503,{"Content-Type":"application/json"});res.end(JSON.stringify(health));
    }).listen(Number(process.env.PORT || 8080),"0.0.0.0");
    process.once("SIGTERM",()=>{running=false;}); process.once("SIGINT",()=>{running=false;});
    try {
        do {
            let pauseSeconds=5;
            const lockClient = await pool.connect();
            try {
                const lock = await lockClient.query("select pg_try_advisory_lock(hashtext('public-tracking-worker'),$1::integer) as locked", [integrationId]);
                if (lock.rows[0]?.locked) {
                    pauseSeconds=300;
                    try { const discoverOrders=!process.argv.includes("--skip-discovery") && Date.now()-lastDiscovery>3600000;
                        heartbeat=Date.now();
                        await pool.query(`insert into shopify_tracking_worker_health(integration_id,last_cycle_at) values($1,now())
                            on conflict(integration_id) do update set last_cycle_at=now()`,[integrationId]);
                        const report=await runCycle(pool,integrationId,
                        { api,reader,discoverOrders,limit:Number(process.env.TRACKING_BATCH_LIMIT || 250),
                            carriers:process.env.TRACKING_CARRIERS?.split(","),onProgress:()=>{heartbeat=Date.now();},
                            approveHistorical:process.argv.includes("--approve-history") || (process.env.TRACKING_APPROVE_HISTORY==="true" && Boolean(process.env.TRACKING_HISTORY_CUTOFF)),actor:process.env.TRACKING_APPROVAL_ACTOR });
                        console.log(JSON.stringify({at:new Date().toISOString(),...report}));
                        latestReport=report;
                        lastCycleFailed=false;
                        lastSuccessAt=new Date().toISOString();
                        const warning = trackingWarning(report);
                        await pool.query(`update shopify_tracking_worker_health set last_success_at=now(),last_error=$3,last_report=$2::jsonb where integration_id=$1`,[integrationId,JSON.stringify(report),warning]);
                        if(discoverOrders) lastDiscovery=Date.now(); }
                    catch(error){
                        lastCycleFailed=true;
                        const code=safeError(error,"TRACKING_CYCLE_FAILED");
                        await pool.query("update shopify_tracking_worker_health set last_error=$2 where integration_id=$1",[integrationId,code]);
                        console.error(JSON.stringify({at:new Date().toISOString(),code}));
                        if(process.argv.includes("--once")) throw Error(code);
                    }
                    finally { await lockClient.query("select pg_advisory_unlock(hashtext('public-tracking-worker'),$1::integer)", [integrationId]); }
                }
            } finally { lockClient.release(); }
            if (process.argv.includes("--once")) break;
            for (let seconds=0; running && seconds<pauseSeconds; seconds+=1) await new Promise((r)=>setTimeout(r,1000));
        } while(running);
    } finally { if(healthServer) await new Promise((resolve)=>healthServer.close(resolve));await pool.end(); }
}

if(require.main===module) main().catch((error)=>{console.error(safeError(error,"TRACKING_CYCLE_FAILED"));process.exitCode=1;});
module.exports={canTrack,validateRemote,assertFeatures,scanEvent,storeScan,approveHistory,discover,pollDue,runCycle,transaction,
    trackingWarning,trackingHealth,unresolvedChecks,safeError,retryCheckAt};
