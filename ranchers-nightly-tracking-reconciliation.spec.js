"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { assertScope, SCOPE, reconcile } = require("./scripts/reconcile-ranchers-shopify-tracking");
const integration = { id: 4, account_name: SCOPE.account, store_identifier: SCOPE.store,
    provider: "SHOPIFY", is_active: true, settings: { publicCarrierTrackingEnabled: true, carrierFulfillmentEventsEnabled: true } };

test("nightly tracking reconciliation pins tenant, store, integration, warehouse and restricted role", () => {
    assert.doesNotThrow(() => assertScope(integration, {role:SCOPE.databaseRole}, 0));
    for (const row of [{...integration,id:5},{...integration,account_name:"OTHER TEST COMPANY"},
        {...integration,store_identifier:"other-test.myshopify.com"},{...integration,is_active:false},
        {...integration,settings:{publicCarrierTrackingEnabled:true}}])
        assert.throws(() => assertScope(row,{role:SCOPE.databaseRole},0),/INTEGRATION_SCOPE_MISMATCH/);
    assert.throws(() => assertScope(null,{role:SCOPE.databaseRole},0),/INTEGRATION_SCOPE_MISMATCH/);
    assert.throws(() => assertScope(integration,{role:"postgres"},0),/RESTRICTED_ROLE_REQUIRED/);
    for (const count of [1,undefined,"0",NaN])
        assert.throws(() => assertScope(integration,{role:SCOPE.databaseRole},count),/WAREHOUSE_SCOPE_MISMATCH/);
});

test("nightly tracking uses the shared worker lock and cannot reset retries or change business transactions", () => {
    const source = fs.readFileSync(require.resolve("./scripts/reconcile-ranchers-shopify-tracking"),"utf8");
    assert.match(source,/pg_try_advisory_lock\(hashtext\('public-tracking-worker'\)/);
    assert.match(source,/pg_advisory_unlock/);
    assert.match(source,/LIVE_WORKER_BUSY/);
    assert.match(source,/if \(!apply\) return \{ mode: "READ_ONLY"/);
    assert.match(source,/remoteReadbackRequired: true/);
    assert.doesNotMatch(source,/update (?:shipment_trackers|portal_orders|inventory|store_integrations)|notifyCustomer|correctTracker|resendTracker/i);
});

function fixture(locked = true) {
    const queries = [];
    let released = 0;
    const query = async (sql, args) => {
        queries.push({sql,args});
        if (sql === "select current_user as role") return {rows:[{role:SCOPE.databaseRole}]};
        if (sql.startsWith("select * from store_integrations")) return {rows:[integration]};
        if (sql.startsWith("select count(*)::int as count from (")) return {rows:[{count:0}]};
        if (sql.startsWith("select feature_flags")) return {rows:[{feature_flags:null}]};
        if (sql.includes("pg_try_advisory_lock")) return {rows:[{locked}]};
        return {rows:[]};
    };
    const pool = {query,connect:async()=>({query,release:()=>{released += 1;}})};
    return {pool,queries,get released(){return released;}};
}

test("read-only reconciliation and a busy live worker cannot start corrective processing", async () => {
    for (const apply of [false,true]) {
        const f=fixture(false);
        let runs=0;
        const result=await reconcile(f.pool,{apply,api:{verify:async()=>{}},runCycle:async()=>{runs += 1;}});
        assert.equal(runs,0);
        assert.equal(result.mode,apply?"APPLY":"READ_ONLY");
        if (apply) assert.equal(result.deferred,"LIVE_WORKER_BUSY");
        assert.equal(f.queries.some(q=>q.sql.includes("pg_advisory_unlock")),false);
        assert.equal(f.released,apply?2:1);
    }
});

test("corrective processing releases the shared lock on failure and always requires remote readback", async () => {
    for (const fail of [false,true]) {
        const f=fixture();
        let runs=0;
        const execute=()=>reconcile(f.pool,{apply:true,api:{verify:async()=>{}},runCycle:async(_pool,id,options)=>{
            runs += 1;
            assert.equal(id,4);
            assert.equal(options.discoverOrders,true);
            assert.deepEqual(options.carriers,["CANPAR","ICS_COURIER","GLS"]);
            if (fail) throw Error("ISOLATED_FAILURE");
            return {polling:{failed:0},failed:0,unresolved:0,discovery:{failed:0}};
        }});
        if (fail) await assert.rejects(execute,/ISOLATED_FAILURE/);
        else assert.equal((await execute()).remoteReadbackRequired,true);
        assert.equal(runs,1);
        assert.equal(f.released,3);
        assert.equal(f.queries.filter(q=>q.sql.includes("pg_advisory_unlock")).length,1);
        assert.equal(f.queries.filter(q=>q.sql.startsWith("select current_user")).length,2);
    }
});
