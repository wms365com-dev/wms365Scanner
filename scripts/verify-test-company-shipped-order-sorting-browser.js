"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { chromium } = require("@playwright/test");

const PROJECT_ID = "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698";
const ENVIRONMENT_ID = "ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6";
const SERVICE_ID = "98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b";
const ORIGIN = "https://wms365-sandbox-customer-sandbox.up.railway.app";
const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });
const TEST_WAREHOUSE = "TEST-WMS-A";

function encodeScript(source) {
    return Buffer.from(source, "utf8").toString("base64");
}

function runRemote(source, sessionId) {
    const encoded = encodeScript(source);
    const railwayArgs = [
        "ssh", "--project", PROJECT_ID,
        "--environment", ENVIRONMENT_ID,
        "--service", SERVICE_ID,
        "node", "-e", `eval(Buffer.from('${encoded}','base64').toString())`
    ];
    const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "railway";
    const args = process.platform === "win32"
        ? ["/d", "/s", "/c", "railway", ...railwayArgs]
        : railwayArgs;
    const result = spawnSync(command, args, {
        encoding: "utf8",
        env: {
            ...process.env,
            RAILWAY_CALLER: "wms365-browser-verifier",
            RAILWAY_AGENT_SESSION: sessionId
        },
        timeout: 90000
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Remote verifier failed.").trim());
    const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
    if (!jsonLine) throw new Error(`Remote verifier returned no JSON result: ${result.stdout}`);
    return JSON.parse(jsonLine);
}

function runRemoteWithRetries(source, sessionId, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return runRemote(source, sessionId);
        } catch (error) {
            lastError = error;
            if (!/timed?\s*out|timeout|connect|econn|eai_again|spawnSync railway\.cmd EINVAL/i.test(String(error?.message || error))) {
                throw error;
            }
        }
    }
    throw lastError;
}

function fixtureSetupSource(runId) {
    return `
const crypto=require("crypto");const{Pool}=require("pg");
const hash=(v)=>crypto.createHash("sha256").update(v).digest("hex");
(async()=>{const p=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});
const run=${JSON.stringify(runId)},email="test-qa17-"+run.toLowerCase()+"@invalid.example",prefix="TEST-QA17-"+run;
const c=await p.connect();try{await c.query("begin");
const company=await c.query("select id::text,name from owner_accounts where id='1510' and name='CODEX PORTAL SYSTEM TEST' and is_active=true for share");if(company.rowCount!==1)throw new Error("Pinned test company unavailable");
const location=await c.query("select fl.id::text from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id where cfl.account_name='CODEX PORTAL SYSTEM TEST' and fl.code='TEST-WMS-A' and fl.is_active=true");if(location.rowCount!==1)throw new Error("Pinned test warehouse unavailable");const locationId=location.rows[0].id;
const user=await c.query("insert into app_users(email,password_hash,full_name,role,is_active) values($1,'TEST-NO-PASSWORD-LOGIN',$2,'warehouse_worker',true) returning id::text",[email,prefix+" worker"]);const userId=user.rows[0].id;
await c.query("insert into app_user_company_access(app_user_id,account_name) values($1,'CODEX PORTAL SYSTEM TEST')",[userId]);await c.query("insert into app_user_fulfillment_location_access(app_user_id,fulfillment_location_id) values($1,$2)",[userId,locationId]);
const token=crypto.randomBytes(32).toString("hex");await c.query("insert into app_sessions(app_user_id,token_hash,expires_at) values($1,$2,now()+interval '15 minutes')",[userId,hash(token)]);
const oldCode=prefix+"-001",newCode=prefix+"-002";const orders=await c.query("insert into portal_orders(order_code,account_name,status,po_number,shipping_reference,ship_to_name,requested_ship_date,confirmed_ship_date,shipped_at,fulfillment_location_id) values($1,'CODEX PORTAL SYSTEM TEST','SHIPPED','TEST-QA17-PO-1',$1,'QA17 Receiver',current_date-2,current_date-2,now()-interval '2 days',$3),($2,'CODEX PORTAL SYSTEM TEST','SHIPPED','TEST-QA17-PO-2',$2,'QA17 Receiver',current_date-1,current_date-1,now()-interval '1 day',$3) returning id::text,order_code",[oldCode,newCode,locationId]);
await c.query("commit");console.log(JSON.stringify({token,userId,email,locationId,oldCode,newCode,orderIds:orders.rows.map(r=>r.id)}));}catch(e){await c.query("rollback");throw e}finally{c.release();await p.end()}})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});`;
}

function fixtureCleanupSource(runId) {
    return `
const{Pool}=require("pg");(async()=>{const p=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});const run=${JSON.stringify(runId)},email="test-qa17-"+run.toLowerCase()+"@invalid.example",pattern="TEST-QA17-"+run+"%";const c=await p.connect();try{await c.query("begin");const users=await c.query("select id from app_users where email=$1",[email]);for(const row of users.rows){await c.query("delete from access_restriction_log where app_user_id=$1",[row.id]);await c.query("delete from app_sessions where app_user_id=$1",[row.id]);await c.query("delete from app_user_fulfillment_location_access where app_user_id=$1",[row.id]);await c.query("delete from app_user_company_access where app_user_id=$1",[row.id]);}await c.query("delete from app_users where email=$1",[email]);await c.query("delete from portal_orders where order_code like $1",[pattern]);const residue=await c.query("select (select count(*) from app_users where email=$1)::int users,(select count(*) from portal_orders where order_code like $2)::int orders",[email,pattern]);if(residue.rows[0].users||residue.rows[0].orders)throw new Error("QA17 cleanup left fixture residue");await c.query("commit");console.log(JSON.stringify({cleaned:true,users:0,orders:0}));}catch(e){await c.query("rollback");throw e}finally{c.release();await p.end()}})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});`;
}

function fixtureResidueSource(runId) {
    return `
const{Pool}=require("pg");(async()=>{const p=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});const run=${JSON.stringify(runId)},email="test-qa17-"+run.toLowerCase()+"@invalid.example",pattern="TEST-QA17-"+run+"%";const residue=await p.query("select (select count(*) from app_users where email=$1)::int users,(select count(*) from portal_orders where order_code like $2)::int orders",[email,pattern]);await p.end();console.log(JSON.stringify(residue.rows[0]));})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});`;
}

async function main() {
    const runId = crypto.randomBytes(6).toString("hex").toUpperCase();
    const sessionId = `wms365-qa17-browser-${runId.toLowerCase()}`;
    let browser;
    let setup;
    let primaryError;
    try {
        setup = runRemoteWithRetries(fixtureSetupSource(runId), sessionId);
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "en-CA" });
        await context.addCookies([{
            name: "wms365_app_session", value: setup.token,
            domain: "wms365-sandbox-customer-sandbox.up.railway.app", path: "/",
            httpOnly: true, secure: true, sameSite: "Lax"
        }]);
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${ORIGIN}/app`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.locator("#desktopCompanySwitcherSummary").waitFor({ state: "visible", timeout: 30000 });
        await page.locator("#desktopCompanySwitcherSummary").click();
        const companyOption = page.locator('[data-company-switcher-value]').filter({ hasText: TEST_COMPANY.name });
        await companyOption.waitFor({ state: "visible", timeout: 30000 });
        await companyOption.click();
        await page.locator(`#activeWarehouse option`).filter({ hasText: TEST_WAREHOUSE }).waitFor({ state: "attached", timeout: 30000 });
        await page.locator("#activeWarehouse").selectOption(TEST_WAREHOUSE);
        const outboundMenu = page.locator("details.module-menu").filter({ has: page.locator("summary", { hasText: "Outbound" }) });
        await outboundMenu.locator("summary").click();
        await outboundMenu.locator('[data-jump-section="shipped"]').click();
        const orderRows = page.locator("#portalOrdersList tbody tr").filter({ hasText: `TEST-QA17-${runId}` });
        await orderRows.first().waitFor({ state: "visible", timeout: 30000 });

        const visibleCodes = async () => orderRows.locator("td:nth-child(2)").allTextContents();
        assertOrder(await visibleCodes(), [setup.newCode, setup.oldCode], "default newest-first");
        const shippedHeader = page.locator('[data-sort-shipped-orders="shippedAt"]');
        if (await shippedHeader.locator("xpath=..").getAttribute("aria-sort") !== "descending") throw new Error("Shipped Date did not announce descending default order.");

        const numberHeader = page.locator('[data-sort-shipped-orders="orderCode"]');
        await numberHeader.click();
        assertOrder(await visibleCodes(), [setup.oldCode, setup.newCode], "order-number ascending");
        if (await numberHeader.locator("xpath=..").getAttribute("aria-sort") !== "ascending") throw new Error("Order number did not announce ascending order.");
        await numberHeader.click();
        assertOrder(await visibleCodes(), [setup.newCode, setup.oldCode], "order-number descending");

        await orderRows.filter({ hasText: setup.newCode }).locator("button[data-open-warehouse-order]").click();
        await page.waitForFunction((orderId) => new URLSearchParams(window.location.search).get("salesOrderId") === orderId, setup.orderIds[1], { timeout: 30000 });
        await page.locator("#warehouseOrderTitle").filter({ hasText: setup.newCode }).waitFor({ state: "visible", timeout: 30000 });
        await page.locator("#closeWarehouseOrderEntryBtn").click();
        await outboundMenu.locator("summary").click();
        await outboundMenu.locator('[data-jump-section="orders"]').first().click();
        if (await page.locator('[data-sort-shipped-orders]').count()) throw new Error("Shipped sort controls leaked into the live Sales Orders view.");
        if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(" | ")}`);
        await context.close();
        console.log(JSON.stringify({ verified: true, companyId: TEST_COMPANY.id, warehouse: TEST_WAREHOUSE, defaultOrder: "newest-first", ascending: true, descending: true, rowOpen: true, salesOrdersUnaffected: true }));
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (setup) {
            try {
                const cleanup = runRemoteWithRetries(fixtureCleanupSource(runId), sessionId);
                if (!cleanup.cleaned) throw new Error("QA17 fixture cleanup was not confirmed.");
                const residue = runRemoteWithRetries(fixtureResidueSource(runId), sessionId);
                if (residue.users || residue.orders) throw new Error(`QA17 fixture residue remained: ${JSON.stringify(residue)}`);
            } catch (cleanupError) {
                if (primaryError) primaryError.cleanupError = cleanupError;
                else throw cleanupError;
            }
        }
    }
}

function assertOrder(actual, expected, label) {
    const normalized = actual.map((value) => String(value).trim().split(/\s+/)[0]);
    if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
        throw new Error(`${label} order mismatch: ${JSON.stringify(normalized)} expected ${JSON.stringify(expected)}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ verified: false, error: error.message, cleanupError: error.cleanupError?.message || null }));
        process.exitCode = 1;
    });
}

module.exports = { fixtureCleanupSource, fixtureResidueSource, fixtureSetupSource, runRemote, runRemoteWithRetries };
