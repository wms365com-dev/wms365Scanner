"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { chromium } = require("@playwright/test");

const PROJECT_ID = "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698";
const ENVIRONMENT_ID = "ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6";
const SERVICE_ID = "98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b";
const ORIGIN = "https://wms365-sandbox-customer-sandbox.up.railway.app";
const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });

function encodeScript(source) {
    return Buffer.from(source, "utf8").toString("base64");
}

function runRemote(source, sessionId) {
    const railwayArgs = [
        "ssh", "--project", PROJECT_ID,
        "--environment", ENVIRONMENT_ID,
        "--service", SERVICE_ID,
        "node", "-e", `eval(Buffer.from('${encodeScript(source)}','base64').toString())`
    ];
    const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "railway";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "railway", ...railwayArgs] : railwayArgs;
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
            if (!/timed?\s*out|timeout|connect|econn|eai_again|spawnSync railway\.cmd EINVAL/i.test(String(error?.message || error))) throw error;
        }
    }
    throw lastError;
}

function fixtureSetupSource(runId) {
    return `
const crypto=require("crypto");const{Pool}=require("pg");const hash=(v)=>crypto.createHash("sha256").update(v).digest("hex");
(async()=>{const p=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});const run=${JSON.stringify(runId)},email="test-qa20-"+run.toLowerCase()+"@invalid.example";const c=await p.connect();try{await c.query("begin");
const company=await c.query("select id::text,name from owner_accounts where id='1510' and name='CODEX PORTAL SYSTEM TEST' and is_active=true for share");if(company.rowCount!==1)throw new Error("Pinned test company unavailable");
const user=await c.query("insert into app_users(email,password_hash,full_name,role,is_active) values($1,'TEST-NO-PASSWORD-LOGIN',$2,'warehouse_worker',true) returning id::text",[email,"TEST-QA20 "+run+" worker"]);const userId=user.rows[0].id;
await c.query("insert into app_user_company_access(app_user_id,account_name) values($1,'CODEX PORTAL SYSTEM TEST')",[userId]);const token=crypto.randomBytes(32).toString("hex");await c.query("insert into app_sessions(app_user_id,token_hash,expires_at) values($1,$2,now()+interval '15 minutes')",[userId,hash(token)]);
await c.query("commit");console.log(JSON.stringify({token,userId,email}));}catch(e){await c.query("rollback");throw e}finally{c.release();await p.end()}})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});`;
}

function fixtureCleanupSource(runId) {
    return `
const{Pool}=require("pg");(async()=>{const p=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});const email="test-qa20-"+${JSON.stringify(runId)}.toLowerCase()+"@invalid.example";const c=await p.connect();try{await c.query("begin");const users=await c.query("select id from app_users where email=$1",[email]);for(const row of users.rows){await c.query("delete from access_restriction_log where app_user_id=$1",[row.id]);await c.query("delete from app_sessions where app_user_id=$1",[row.id]);await c.query("delete from app_user_company_access where app_user_id=$1",[row.id]);}await c.query("delete from app_users where email=$1",[email]);const residue=await c.query("select count(*)::int users from app_users where email=$1",[email]);if(residue.rows[0].users)throw new Error("QA20 cleanup left fixture residue");await c.query("commit");console.log(JSON.stringify({cleaned:true,users:0}));}catch(e){await c.query("rollback");throw e}finally{c.release();await p.end()}})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});`;
}

function fixtureResidueSource(runId) {
    return `
const{Pool}=require("pg");(async()=>{const p=new Pool({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});const email="test-qa20-"+${JSON.stringify(runId)}.toLowerCase()+"@invalid.example";const residue=await p.query("select count(*)::int users from app_users where email=$1",[email]);await p.end();console.log(JSON.stringify(residue.rows[0]));})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});`;
}

async function main() {
    const runId = crypto.randomBytes(6).toString("hex").toUpperCase();
    const sessionId = `wms365-qa20-browser-${runId.toLowerCase()}`;
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
        let recoveryPosts = 0;
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("request", (request) => {
            if (request.method() === "POST" && new URL(request.url()).pathname === "/api/app/recovery/password") recoveryPosts += 1;
        });
        await page.goto(`${ORIGIN}/app`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.locator("#accountSettingsMenu summary").waitFor({ state: "visible", timeout: 30000 });
        await page.locator("#accountSettingsMenu summary").click();
        await page.locator("#accountResetPasswordBtn").click();
        const modal = page.locator("#warehouseActionConfirmModal");
        await modal.waitFor({ state: "visible", timeout: 30000 });
        await modal.locator("#warehouseActionConfirmTitle").filter({ hasText: "Reset your password?" }).waitFor({ state: "visible" });
        await modal.locator("[data-action-confirm-accept]").filter({ hasText: "Send temporary password" }).waitFor({ state: "visible" });
        await modal.locator("button[data-action-confirm-cancel]").click();
        await modal.waitFor({ state: "detached", timeout: 10000 });
        await page.waitForTimeout(500);
        if (recoveryPosts !== 0) throw new Error(`Cancel path issued ${recoveryPosts} password recovery POST request(s).`);
        if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(" | ")}`);
        await context.close();
        console.log(JSON.stringify({ verified: true, companyId: TEST_COMPANY.id, modalVisible: true, cancelWorked: true, recoveryPosts: 0, pageErrors: 0 }));
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (setup) {
            try {
                const cleanup = runRemoteWithRetries(fixtureCleanupSource(runId), sessionId);
                if (!cleanup.cleaned) throw new Error("QA20 fixture cleanup was not confirmed.");
                const residue = runRemoteWithRetries(fixtureResidueSource(runId), sessionId);
                if (residue.users) throw new Error(`QA20 fixture residue remained: ${JSON.stringify(residue)}`);
            } catch (cleanupError) {
                if (primaryError) primaryError.cleanupError = cleanupError;
                else throw cleanupError;
            }
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ verified: false, error: error.message, cleanupError: error.cleanupError?.message || null }));
        process.exitCode = 1;
    });
}

module.exports = { fixtureCleanupSource, fixtureResidueSource, fixtureSetupSource, runRemote, runRemoteWithRetries };
