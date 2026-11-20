"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const { hashToken, requireSandboxConfiguration } = require("./verify-test-company-authenticated-task-scope");

const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });

async function cleanup(pool, fixture) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        if (fixture.userId) {
            await client.query("delete from access_restriction_log where app_user_id=$1 or request_id like $2", [fixture.userId, `${fixture.requestPrefix}%`]);
            await client.query("delete from app_sessions where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_company_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_users where id=$1", [fixture.userId]);
        }
        const residue = await client.query(
            "select (select count(*) from app_users where email=$1)::integer as users, (select count(*) from app_sessions where app_user_id=$2)::integer as sessions",
            [fixture.email, fixture.userId || 0]
        );
        if (Number(residue.rows[0]?.users) !== 0 || Number(residue.rows[0]?.sessions) !== 0) {
            throw new Error("Logout fixture cleanup left sandbox residue.");
        }
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function fetchMe(origin, token, requestId) {
    const response = await fetch(`${origin}/api/app/me`, {
        headers: {
            accept: "application/json",
            cookie: `wms365_app_session=${encodeURIComponent(token)}`,
            "x-request-id": requestId
        }
    });
    return { status: response.status, body: await response.json() };
}

async function main(env = process.env) {
    const config = requireSandboxConfiguration(env);
    const pool = new Pool({ connectionString: config.connectionString, max: 2 });
    const runId = crypto.randomBytes(8).toString("hex").toUpperCase();
    const fixture = {
        email: `test-logout-${runId.toLowerCase()}@invalid.example`,
        requestPrefix: `TEST-LOGOUT-${runId}`,
        userId: null
    };
    let primaryError = null;
    try {
        const company = await requireDesignatedTestCompany(pool);
        if (company.id !== TEST_COMPANY.id || company.name !== TEST_COMPANY.name) {
            throw new Error("Designated test company identity mismatch.");
        }

        const sessionToken = crypto.randomBytes(32).toString("hex");
        const client = await pool.connect();
        try {
            await client.query("begin");
            const identity = await client.query(
                "select id::text,name from owner_accounts where id=$1 and name=$2 and is_active=true for share",
                [TEST_COMPANY.id, TEST_COMPANY.name]
            );
            if (identity.rowCount !== 1) throw new Error("Designated test company became unavailable before fixture creation.");
            const user = await client.query(
                `insert into app_users (email,password_hash,full_name,role,is_active)
                 values ($1,$2,$3,'warehouse_worker',true) returning id::text`,
                [fixture.email, "TEST-NO-PASSWORD-LOGIN", `${fixture.requestPrefix} worker`]
            );
            fixture.userId = user.rows[0].id;
            await client.query(
                "insert into app_user_company_access (app_user_id,account_name) values ($1,$2)",
                [fixture.userId, TEST_COMPANY.name]
            );
            await client.query(
                "insert into app_sessions (app_user_id,token_hash,expires_at) values ($1,$2,now()+interval '10 minutes')",
                [fixture.userId, hashToken(sessionToken)]
            );
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        const before = await fetchMe(config.origin, sessionToken, `${fixture.requestPrefix}-BEFORE`);
        if (before.status !== 200 || before.body?.authenticated !== true) {
            throw new Error("Sandbox session was not authenticated before logout.");
        }

        const response = await fetch(`${config.origin}/api/app/logout?redirect=desktop`, {
            method: "POST",
            redirect: "manual",
            headers: {
                cookie: `wms365_app_session=${encodeURIComponent(sessionToken)}`,
                "x-request-id": `${fixture.requestPrefix}-LOGOUT`
            }
        });
        if (response.status !== 303 || response.headers.get("location") !== "/login.html?next=%2Fdesktop") {
            throw new Error(`Logout returned HTTP ${response.status} without the expected desktop redirect.`);
        }
        const clearedCookie = response.headers.get("set-cookie") || "";
        if (!/wms365_app_session=;/i.test(clearedCookie) || !/Max-Age=0/i.test(clearedCookie)) {
            throw new Error("Logout did not clear the application session cookie.");
        }

        const after = await fetchMe(config.origin, sessionToken, `${fixture.requestPrefix}-AFTER`);
        if (after.status !== 200 || after.body?.authenticated !== false) {
            throw new Error("The logged-out session remained usable.");
        }
        const sessionCount = await pool.query("select count(*)::integer as count from app_sessions where app_user_id=$1", [fixture.userId]);
        if (Number(sessionCount.rows[0]?.count) !== 0) throw new Error("Logout left the server session row behind.");

        console.log(JSON.stringify({
            verified: true,
            designatedCompanyId: TEST_COMPANY.id,
            redirectStatus: response.status,
            cookieCleared: true,
            sessionInvalidated: true,
            cleanupPending: true
        }));
        return { verified: true };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        try {
            await cleanup(pool, fixture);
        } catch (cleanupError) {
            if (primaryError) primaryError.cleanupError = cleanupError;
            else throw cleanupError;
        } finally {
            await pool.end();
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ verified: false, error: error.message }));
        process.exitCode = 1;
    });
}

module.exports = { main };
