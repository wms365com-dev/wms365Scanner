"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");

const SANDBOX_ENVIRONMENT = "customer-sandbox";
const SANDBOX_SERVICE = "wms365-sandbox";
const SANDBOX_ENVIRONMENT_ID = "ba0e38d2-cf0c-440b-aace-f8eb0f03b5a6";
const SANDBOX_SERVICE_ID = "98c3a0c6-d0bb-4a7b-b392-d0baf509ad8b";
const SANDBOX_DATABASE_HOST = "postgres-xihr.railway.internal";
const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });
const ALLOWED_TASK_COUNT = 321;
const DENIED_WAREHOUSE_TASK_COUNT = 19;
const DENIED_COMPANY_TASK_COUNT = 11;

function requireSandboxConfiguration(env = process.env) {
    if (env.RAILWAY_ENVIRONMENT_NAME !== SANDBOX_ENVIRONMENT) {
        throw new Error(`Sandbox verification requires RAILWAY_ENVIRONMENT_NAME=${SANDBOX_ENVIRONMENT}.`);
    }
    if (env.RAILWAY_SERVICE_NAME !== SANDBOX_SERVICE) {
        throw new Error(`Sandbox verification requires RAILWAY_SERVICE_NAME=${SANDBOX_SERVICE}.`);
    }
    if (env.RAILWAY_ENVIRONMENT_ID !== SANDBOX_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID !== SANDBOX_SERVICE_ID) {
        throw new Error("Sandbox verification requires the pinned customer-sandbox environment and wms365-sandbox service IDs.");
    }
    if (env.WMS365_SANDBOX_EXTERNAL_SIDE_EFFECTS_DISABLED !== "true") {
        throw new Error("Sandbox verification requires external email, carrier, Shopify and billing effects to be disabled.");
    }
    if (!env.DATABASE_PRIVATE_URL) {
        throw new Error("Sandbox verification requires the isolated Postgres-XihR private database URL.");
    }

    let databaseUrl;
    let origin;
    try {
        databaseUrl = new URL(env.DATABASE_PRIVATE_URL);
        origin = new URL(env.WMS365_SANDBOX_ORIGIN);
    } catch {
        throw new Error("Sandbox DATABASE_PRIVATE_URL and WMS365_SANDBOX_ORIGIN must be valid URLs.");
    }
    if (!/^postgres(?:ql)?:$/.test(databaseUrl.protocol)) {
        throw new Error("Sandbox DATABASE_PRIVATE_URL must use PostgreSQL.");
    }
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("WMS365_SANDBOX_ORIGIN must be an HTTPS origin without a path, query or fragment.");
    }
    const host = origin.hostname.toLowerCase();
    if (!host.includes("wms365-sandbox") || host === "app.wms365.co" || host.includes("production")) {
        throw new Error("WMS365_SANDBOX_ORIGIN is not the isolated WMS365 sandbox host.");
    }
    const databaseHost = databaseUrl.hostname.toLowerCase();
    if (databaseHost !== SANDBOX_DATABASE_HOST) {
        throw new Error("DATABASE_PRIVATE_URL does not identify the pinned isolated Postgres-XihR database.");
    }
    return { connectionString: env.DATABASE_PRIVATE_URL, origin: origin.origin };
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function taskIds(payload) {
    if (!payload || !Array.isArray(payload.tasks)) throw new Error("Warehouse task response did not contain a tasks array.");
    return payload.tasks.map((task) => String(task.id));
}

function assertExactTaskScope(payload, expectedIds, forbiddenIds) {
    const actual = taskIds(payload);
    const expected = [...expectedIds].map(String).sort();
    const sortedActual = [...actual].sort();
    if (new Set(actual).size !== actual.length) throw new Error("Authenticated task response contained duplicate task IDs.");
    if (JSON.stringify(sortedActual) !== JSON.stringify(expected)) {
        throw new Error(`Authenticated task scope mismatch: expected ${expected.length}, received ${actual.length}.`);
    }
    const actualSet = new Set(actual);
    const leaked = [...forbiddenIds].map(String).filter((id) => actualSet.has(id));
    if (leaked.length) throw new Error(`Authenticated task scope leaked ${leaked.length} denied task(s).`);
    return actual.length;
}

async function insertTasks(client, { prefix, accountName, locationId, count }) {
    const result = await client.query(
        `insert into warehouse_tasks
            (task_code, task_type, source_type, account_name, fulfillment_location_id, status, priority, title, details, metadata)
         select $1 || lpad(series::text, 4, '0'), 'PICK', 'MANUAL', $2, $3, 'OPEN', 'NORMAL',
                $1 || ' authenticated scope fixture', 'TEST authenticated sandbox-only task',
                jsonb_build_object('testReference', $1, 'synthetic', true)
         from generate_series(1, $4::integer) series
         returning id::text`,
        [prefix, accountName, locationId, count]
    );
    return result.rows.map((row) => row.id);
}

async function fetchJson(origin, path, token, requestId) {
    const response = await fetch(`${origin}${path}`, {
        method: "GET",
        redirect: "error",
        headers: {
            accept: "application/json",
            cookie: `wms365_app_session=${encodeURIComponent(token)}`,
            "x-request-id": requestId
        }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: response.status, body };
}

async function cleanup(pool, fixture) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        if (fixture.userId) {
            await client.query("delete from access_restriction_log where app_user_id=$1 or request_id=$2", [fixture.userId, fixture.requestId]);
            await client.query("delete from app_sessions where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_fulfillment_location_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_company_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_users where id=$1", [fixture.userId]);
        }
        await client.query("set local session_replication_role = replica");
        await client.query(
            "delete from warehouse_task_history where task_id in (select id from warehouse_tasks where task_code like $1)",
            [`${fixture.prefix}%`]
        );
        await client.query("delete from warehouse_tasks where task_code like $1", [`${fixture.prefix}%`]);
        await client.query("set local session_replication_role = origin");
        if (fixture.locationIds.length) {
            await client.query("delete from company_fulfillment_locations where fulfillment_location_id=any($1::bigint[])", [fixture.locationIds]);
            await client.query("delete from fulfillment_locations where id=any($1::bigint[])", [fixture.locationIds]);
        }
        if (fixture.deniedCompany) {
            await client.query("delete from owner_accounts where name=$1", [fixture.deniedCompany]);
        }
        const residue = await client.query(
            `select
                (select count(*) from warehouse_tasks where task_code like $1)::integer as tasks,
                (select count(*) from app_users where id=$2)::integer as users,
                (select count(*) from fulfillment_locations where id=any($3::bigint[]))::integer as locations,
                (select count(*) from owner_accounts where name=$4)::integer as companies`,
            [`${fixture.prefix}%`, fixture.userId || 0, fixture.locationIds, fixture.deniedCompany || ""]
        );
        if (Object.values(residue.rows[0] || {}).some((value) => Number(value) !== 0)) {
            throw new Error("Authenticated task-scope fixture cleanup left sandbox residue.");
        }
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function cleanupStaleScopeFixtures(pool) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const staleUsers = await client.query(
            "select id from app_users where email like 'test-auth-scope-%@invalid.example'"
        );
        const userIds = staleUsers.rows.map((row) => String(row.id));
        if (userIds.length) {
            await client.query("delete from access_restriction_log where app_user_id=any($1::bigint[]) or request_id like 'TEST-AUTH-SCOPE-%'", [userIds]);
            await client.query("delete from app_sessions where app_user_id=any($1::bigint[])", [userIds]);
            await client.query("delete from app_user_fulfillment_location_access where app_user_id=any($1::bigint[])", [userIds]);
            await client.query("delete from app_user_company_access where app_user_id=any($1::bigint[])", [userIds]);
            await client.query("delete from app_users where id=any($1::bigint[])", [userIds]);
        }
        await client.query("set local session_replication_role = replica");
        await client.query(
            "delete from warehouse_task_history where task_id in (select id from warehouse_tasks where task_code like 'TEST-AUTH-TASK-SCOPE-%')"
        );
        await client.query("delete from warehouse_tasks where task_code like 'TEST-AUTH-TASK-SCOPE-%'");
        await client.query("set local session_replication_role = origin");
        const staleLocations = await client.query(
            "select id from fulfillment_locations where code like 'TEST-AUTH-ALLOW-%' or code like 'TEST-AUTH-DENY-%'"
        );
        const locationIds = staleLocations.rows.map((row) => String(row.id));
        if (locationIds.length) {
            await client.query("delete from company_fulfillment_locations where fulfillment_location_id=any($1::bigint[])", [locationIds]);
            await client.query("delete from fulfillment_locations where id=any($1::bigint[])", [locationIds]);
        }
        await client.query("delete from owner_accounts where name like 'TEST-AUTH-DENIED-%'");
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function main(env = process.env) {
    const config = requireSandboxConfiguration(env);
    const pool = new Pool({ connectionString: config.connectionString, max: 3 });
    const runId = crypto.randomBytes(8).toString("hex").toUpperCase();
    const fixture = {
        prefix: `TEST-AUTH-TASK-SCOPE-${runId}-`,
        deniedCompany: `TEST-AUTH-DENIED-${runId}`,
        requestId: `TEST-AUTH-SCOPE-${runId}`,
        locationIds: [],
        userId: null
    };
    let primaryError = null;
    try {
        const company = await requireDesignatedTestCompany(pool);
        if (company.id !== TEST_COMPANY.id || company.name !== TEST_COMPANY.name) {
            throw new Error("Designated test company identity mismatch.");
        }
        await cleanupStaleScopeFixtures(pool);

        const client = await pool.connect();
        let allowedIds;
        let deniedWarehouseIds;
        let deniedCompanyIds;
        let sessionToken;
        try {
            await client.query("begin");
            const identity = await client.query(
                "select id::text,name,is_active from owner_accounts where id=$1 and name=$2 and is_active=true for share",
                [TEST_COMPANY.id, TEST_COMPANY.name]
            );
            if (identity.rowCount !== 1) throw new Error("Designated test company became unavailable before fixture creation.");

            await client.query(
                "insert into owner_accounts (name,note,is_active) values ($1,$2,true)",
                [fixture.deniedCompany, `${fixture.prefix} denied-company fixture`]
            );
            const locations = await client.query(
                `insert into fulfillment_locations (code,name,partner_name,location_type,note,is_active)
                 values ($1,$2,'TEST','OWN_WAREHOUSE',$4,true),($3,$5,'TEST','OWN_WAREHOUSE',$4,true)
                 returning id`,
                [
                    `TEST-AUTH-ALLOW-${runId}`, `TEST Auth Allowed ${runId}`,
                    `TEST-AUTH-DENY-${runId}`, fixture.prefix,
                    `TEST Auth Denied ${runId}`
                ]
            );
            fixture.locationIds = locations.rows.map((row) => String(row.id));
            const [allowedLocationId, deniedLocationId] = fixture.locationIds;
            await client.query(
                `insert into company_fulfillment_locations (account_name,fulfillment_location_id,is_primary,note)
                 values ($1,$2,true,$4),($1,$3,false,$4),($5,$3,true,$4)`,
                [TEST_COMPANY.name, allowedLocationId, deniedLocationId, fixture.prefix, fixture.deniedCompany]
            );
            const user = await client.query(
                `insert into app_users (email,password_hash,full_name,role,is_active)
                 values ($1,$2,$3,'warehouse_worker',true) returning id`,
                [`test-auth-scope-${runId.toLowerCase()}@invalid.example`, "TEST-NO-PASSWORD-LOGIN", `${fixture.prefix} restricted worker`]
            );
            fixture.userId = String(user.rows[0].id);
            await client.query(
                "insert into app_user_company_access (app_user_id,account_name) values ($1,$2)",
                [fixture.userId, TEST_COMPANY.name]
            );
            await client.query(
                "insert into app_user_fulfillment_location_access (app_user_id,fulfillment_location_id) values ($1,$2)",
                [fixture.userId, allowedLocationId]
            );
            sessionToken = crypto.randomBytes(32).toString("hex");
            await client.query(
                "insert into app_sessions (app_user_id,token_hash,expires_at) values ($1,$2,now()+interval '10 minutes')",
                [fixture.userId, hashToken(sessionToken)]
            );
            allowedIds = await insertTasks(client, {
                prefix: `${fixture.prefix}ALLOW-`, accountName: TEST_COMPANY.name,
                locationId: allowedLocationId, count: ALLOWED_TASK_COUNT
            });
            deniedWarehouseIds = await insertTasks(client, {
                prefix: `${fixture.prefix}DENIED-WH-`, accountName: TEST_COMPANY.name,
                locationId: deniedLocationId, count: DENIED_WAREHOUSE_TASK_COUNT
            });
            deniedCompanyIds = await insertTasks(client, {
                prefix: `${fixture.prefix}DENIED-CO-`, accountName: fixture.deniedCompany,
                locationId: deniedLocationId, count: DENIED_COMPANY_TASK_COUNT
            });
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        const allowedResponse = await fetchJson(
            config.origin,
            `/api/admin/warehouse-tasks?accountName=${encodeURIComponent(TEST_COMPANY.name)}&activeOnly=true`,
            sessionToken,
            fixture.requestId
        );
        if (allowedResponse.status !== 200) throw new Error(`Allowed authenticated task request returned HTTP ${allowedResponse.status}.`);
        const returnedCount = assertExactTaskScope(
            allowedResponse.body,
            allowedIds,
            deniedWarehouseIds.concat(deniedCompanyIds)
        );

        const deniedResponse = await fetchJson(
            config.origin,
            `/api/admin/warehouse-tasks?accountName=${encodeURIComponent(fixture.deniedCompany)}&activeOnly=true`,
            sessionToken,
            fixture.requestId
        );
        if (deniedResponse.status !== 403) {
            throw new Error(`Denied-company authenticated task request returned HTTP ${deniedResponse.status}, expected 403.`);
        }

        console.log(JSON.stringify({
            verified: true,
            designatedCompanyId: TEST_COMPANY.id,
            allowedTaskCount: returnedCount,
            deniedWarehouseTaskCount: deniedWarehouseIds.length,
            deniedCompanyTaskCount: deniedCompanyIds.length,
            deniedCompanyStatus: deniedResponse.status,
            cleanupPending: true
        }));
        return { verified: true, allowedTaskCount: returnedCount };
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

module.exports = {
    ALLOWED_TASK_COUNT,
    DENIED_COMPANY_TASK_COUNT,
    DENIED_WAREHOUSE_TASK_COUNT,
    assertExactTaskScope,
    hashToken,
    main,
    requireSandboxConfiguration,
    taskIds
};
