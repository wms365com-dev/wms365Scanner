"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const { hashToken, requireSandboxConfiguration } = require("./verify-test-company-authenticated-task-scope");

const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });

async function requestJson(origin, path, token, requestId, options = {}) {
    const response = await fetch(`${origin}${path}`, {
        method: options.method || "GET",
        redirect: "error",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: `wms365_app_session=${encodeURIComponent(token)}`,
            "x-request-id": requestId
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: response.status, body };
}

function profileEditPayload(profile, overrides = {}) {
    const fields = [
        "name", "legalName", "accountCode", "contactName", "contactTitle", "email", "phone", "mobile",
        "website", "billingEmail", "apEmail", "portalLoginEmail", "address1", "address2", "city", "state",
        "postalCode", "country", "isActive", "note"
    ];
    const payload = Object.fromEntries(fields.map((field) => [field, profile[field]]));
    return { ...payload, profileEdit: true, expectedUpdatedAt: profile.updatedAt, ...overrides };
}

async function cleanup(pool, fixture) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        if (fixture.originalOwner) {
            await client.query(
                "update owner_accounts set note=$2,updated_at=$3 where id=$1 and name=$4",
                [TEST_COMPANY.id, fixture.originalOwner.note, fixture.originalOwner.updated_at, TEST_COMPANY.name]
            );
        }
        if (fixture.activityFloor !== null) {
            await client.query(
                "delete from activity_log where id>$1 and type='setup' and title=$2 and details like $3",
                [fixture.activityFloor, `Saved company ${TEST_COMPANY.name}`, `%${fixture.marker}%`]
            );
        }
        if (fixture.userIds.length) {
            await client.query("delete from access_restriction_log where app_user_id=any($1::bigint[]) or request_id like $2", [fixture.userIds, `${fixture.requestPrefix}%`]);
            await client.query("delete from app_sessions where app_user_id=any($1::bigint[])", [fixture.userIds]);
            await client.query("delete from app_user_company_access where app_user_id=any($1::bigint[])", [fixture.userIds]);
            await client.query("delete from app_users where id=any($1::bigint[])", [fixture.userIds]);
        }
        const residue = await client.query(
            `select
                (select count(*) from app_users where email like $1)::integer as users,
                (select count(*) from app_sessions where app_user_id=any($2::bigint[]))::integer as sessions,
                (select count(*) from activity_log where id>$3 and title=$4 and details like $5)::integer as activities`,
            [`test-profile-${fixture.runId.toLowerCase()}-%`, fixture.userIds, fixture.activityFloor || 0,
                `Saved company ${TEST_COMPANY.name}`, `%${fixture.marker}%`]
        );
        if (Object.values(residue.rows[0] || {}).some((value) => Number(value) !== 0)) {
            throw new Error("Company-profile verifier cleanup left sandbox residue.");
        }
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
        runId,
        requestPrefix: `TEST-PROFILE-${runId}`,
        marker: `TEST-PROFILE-${runId}`,
        originalOwner: null,
        activityFloor: null,
        userIds: []
    };
    let primaryError = null;
    try {
        const company = await requireDesignatedTestCompany(pool);
        if (company.id !== TEST_COMPANY.id || company.name !== TEST_COMPANY.name) {
            throw new Error("Designated test company identity mismatch.");
        }

        const superToken = crypto.randomBytes(32).toString("hex");
        const workerToken = crypto.randomBytes(32).toString("hex");
        const client = await pool.connect();
        try {
            await client.query("begin");
            const owner = await client.query(
                "select * from owner_accounts where id=$1 and name=$2 and is_active=true for update",
                [TEST_COMPANY.id, TEST_COMPANY.name]
            );
            if (owner.rowCount !== 1) throw new Error("Designated test company became unavailable before verification.");
            fixture.originalOwner = owner.rows[0];
            const activity = await client.query("select coalesce(max(id),0)::bigint as id from activity_log");
            fixture.activityFloor = String(activity.rows[0].id);
            await client.query(
                "update owner_accounts set note=$2,updated_at=now() where id=$1",
                [TEST_COMPANY.id, fixture.marker]
            );
            const users = await client.query(
                `insert into app_users (email,password_hash,full_name,role,is_active)
                 values ($1,'TEST-NO-PASSWORD-LOGIN',$3,'super_admin',true),
                        ($2,'TEST-NO-PASSWORD-LOGIN',$4,'warehouse_worker',true)
                 returning id::text,email,role`,
                [
                    `test-profile-${runId.toLowerCase()}-admin@invalid.example`,
                    `test-profile-${runId.toLowerCase()}-worker@invalid.example`,
                    `${fixture.marker} administrator`, `${fixture.marker} worker`
                ]
            );
            const superUser = users.rows.find((row) => row.role === "super_admin");
            const workerUser = users.rows.find((row) => row.role === "warehouse_worker");
            if (!superUser || !workerUser) throw new Error("Profile verifier users were not created exactly once.");
            fixture.userIds = users.rows.map((row) => row.id);
            await client.query(
                "insert into app_user_company_access (app_user_id,account_name) values ($1,$3),($2,$3)",
                [superUser.id, workerUser.id, TEST_COMPANY.name]
            );
            await client.query(
                `insert into app_sessions (app_user_id,token_hash,expires_at)
                 values ($1,$3,now()+interval '15 minutes'),($2,$4,now()+interval '15 minutes')`,
                [superUser.id, workerUser.id, hashToken(superToken), hashToken(workerToken)]
            );
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        const state = await requestJson(config.origin, "/api/state", superToken, `${fixture.requestPrefix}-STATE`);
        const profile = state.body?.masters?.ownerRecords?.find((entry) => String(entry.id) === TEST_COMPANY.id);
        if (state.status !== 200 || !profile || profile.name !== TEST_COMPANY.name || profile.note !== fixture.marker || !profile.updatedAt) {
            throw new Error("Authenticated company profile hydration did not return the exact saved test-company record.");
        }

        const denied = await requestJson(config.origin, "/api/master-owner", workerToken, `${fixture.requestPrefix}-DENIED`, {
            method: "POST",
            body: profileEditPayload(profile, { note: `${fixture.marker}-DENIED` })
        });
        if (denied.status !== 403) throw new Error(`Warehouse worker profile edit returned HTTP ${denied.status}, expected 403.`);

        const stale = await requestJson(config.origin, "/api/master-owner", superToken, `${fixture.requestPrefix}-STALE`, {
            method: "POST",
            body: profileEditPayload(profile, {
                note: `${fixture.marker}-STALE`,
                expectedUpdatedAt: new Date(Date.parse(profile.updatedAt) - 1000).toISOString()
            })
        });
        if (stale.status !== 409) throw new Error(`Stale profile edit returned HTTP ${stale.status}, expected 409.`);

        const blank = await requestJson(config.origin, "/api/master-owner", superToken, `${fixture.requestPrefix}-BLANK`, {
            method: "POST",
            body: profileEditPayload(profile, { note: "" })
        });
        if (blank.status !== 409) throw new Error(`Blank profile overwrite returned HTTP ${blank.status}, expected 409.`);

        const beforeValid = await pool.query("select note,updated_at from owner_accounts where id=$1", [TEST_COMPANY.id]);
        if (beforeValid.rows[0]?.note !== fixture.marker || new Date(beforeValid.rows[0].updated_at).toISOString() !== profile.updatedAt) {
            throw new Error("Rejected profile edits changed the saved company record.");
        }

        const validNote = `${fixture.marker}-VALID`;
        const valid = await requestJson(config.origin, "/api/master-owner", superToken, `${fixture.requestPrefix}-VALID`, {
            method: "POST",
            body: profileEditPayload(profile, { note: validNote })
        });
        if (valid.status !== 200 || valid.body?.success !== true) {
            throw new Error(`Valid profile edit returned HTTP ${valid.status}.`);
        }
        const saved = await pool.query("select note,updated_at from owner_accounts where id=$1", [TEST_COMPANY.id]);
        if (saved.rows[0]?.note !== validNote || new Date(saved.rows[0].updated_at).toISOString() === profile.updatedAt) {
            throw new Error("Valid company profile edit was not persisted with a new version.");
        }

        console.log(JSON.stringify({
            verified: true,
            designatedCompanyId: TEST_COMPANY.id,
            hydrated: true,
            unauthorizedStatus: denied.status,
            staleStatus: stale.status,
            blankOverwriteStatus: blank.status,
            validEditStatus: valid.status,
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

module.exports = { main, profileEditPayload };
