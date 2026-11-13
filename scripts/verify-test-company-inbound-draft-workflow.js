"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");

const TEST_COMPANY = "CODEX PORTAL SYSTEM TEST";

function hash(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function request(origin, path, token, method = "GET", body = null) {
    const response = await fetch(`${origin}${path}`, {
        method,
        redirect: "error",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: `wms365_portal_session=${encodeURIComponent(token)}`
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    return { status: response.status, payload };
}

async function main() {
    if (process.env.RAILWAY_ENVIRONMENT_NAME !== "customer-sandbox" || process.env.RAILWAY_SERVICE_NAME !== "wms365-sandbox") {
        throw new Error("This verifier runs only in the pinned customer sandbox application.");
    }
    if (process.env.WMS365_SANDBOX_EXTERNAL_SIDE_EFFECTS_DISABLED !== "true") {
        throw new Error("Sandbox external side effects must be disabled.");
    }
    const origin = new URL(process.env.WMS365_SANDBOX_ORIGIN).origin;
    if (!origin.includes("wms365-sandbox") || !process.env.DATABASE_PRIVATE_URL?.includes("postgres-xihr.railway.internal")) {
        throw new Error("Sandbox origin or database identity mismatch.");
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL, max: 2 });
    const runId = crypto.randomBytes(6).toString("hex").toUpperCase();
    const reference = `TEST-INBOUND-DRAFT-${runId}`;
    const email = `test-inbound-${runId.toLowerCase()}@invalid.example`;
    const token = crypto.randomBytes(32).toString("hex");
    let inboundId = null;
    let accessId = null;
    let originalFeatureFlags = null;
    try {
        await requireDesignatedTestCompany(pool);
        const setup = await pool.connect();
        let locationId;
        let sku;
        try {
            await setup.query("begin");
            await setup.query("alter table warehouse_task_history disable trigger warehouse_task_history_immutable");
            await setup.query(`delete from warehouse_tasks where source_type='PORTAL_INBOUND' and source_id in
                (select id from portal_inbounds where account_name=$1 and reference_number like 'TEST-INBOUND-DRAFT-%')`, [TEST_COMPANY]);
            await setup.query("delete from portal_inbounds where account_name=$1 and reference_number like 'TEST-INBOUND-DRAFT-%'", [TEST_COMPANY]);
            await setup.query("delete from activity_log where title like '%TEST-INBOUND-DRAFT-%'");
            await setup.query(`delete from portal_sessions where portal_access_id in
                (select id from portal_vendor_access where account_name=$1 and email like 'test-inbound-%@invalid.example')`, [TEST_COMPANY]);
            await setup.query("delete from portal_vendor_access where account_name=$1 and email like 'test-inbound-%@invalid.example'", [TEST_COMPANY]);
            await setup.query("alter table warehouse_task_history enable trigger warehouse_task_history_immutable");
            const feature = await setup.query("select feature_flags from owner_accounts where id=1510 and name=$1 and is_active=true for update", [TEST_COMPANY]);
            if (feature.rowCount !== 1) throw new Error("Designated test company is unavailable.");
            originalFeatureFlags = feature.rows[0].feature_flags || {};
            await setup.query(
                "update owner_accounts set feature_flags=$2::jsonb where id=1510 and name=$1",
                [TEST_COMPANY, JSON.stringify({ ...originalFeatureFlags, INBOUND_NOTICES: true })]
            );
            const location = await setup.query(`select fl.id::text from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id where cfl.account_name=$1 and fl.is_active=true order by cfl.is_primary desc,fl.id limit 1`, [TEST_COMPANY]);
            const item = await setup.query("select sku from item_catalog where account_name=$1 and blocked=false order by id limit 1", [TEST_COMPANY]);
            if (location.rowCount !== 1 || item.rowCount !== 1) throw new Error("Designated test company needs one active warehouse and item.");
            locationId = location.rows[0].id;
            sku = item.rows[0].sku;
            const created = await setup.query(`insert into portal_vendor_access(account_name,email,password_hash,portal_permissions,is_active) values($1,$2,'TEST-NO-LOGIN',$3::jsonb,true) returning id::text`, [TEST_COMPANY, email, JSON.stringify({ inboundEntry: true, documentAccess: true })]);
            accessId = created.rows[0].id;
            await setup.query("insert into portal_sessions(portal_access_id,token_hash,expires_at) values($1,$2,now()+interval '15 minutes')", [accessId, hash(token)]);
            await setup.query("commit");
        } catch (error) {
            await setup.query("rollback").catch(() => {});
            throw error;
        } finally { setup.release(); }

        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const draft = await request(origin, "/api/portal/inbounds", token, "POST", {
            status: "DRAFT", fulfillmentLocationId: locationId, referenceNumber: reference,
            expectedDate: tomorrow, contactName: "Sandbox Test", lines: [{ sku, quantity: 2 }]
        });
        if (draft.status !== 201 || draft.payload?.inbound?.status !== "DRAFT") throw new Error(`Draft creation failed (${draft.status}).`);
        inboundId = draft.payload.inbound.id;
        const denied = await request(origin, "/api/portal/inbounds/999999999", token, "PUT", {
            fulfillmentLocationId: locationId, referenceNumber: reference, expectedDate: tomorrow,
            contactName: "Sandbox Test", lines: [{ sku, quantity: 2 }]
        });
        if (denied.status !== 404) throw new Error(`Foreign-resource denial returned ${denied.status}.`);
        const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        const document = await request(origin, `/api/portal/inbounds/${inboundId}/documents`, token, "POST", { documents: [{ fileName: `${reference}.png`, fileType: "image/png", dataUrl: png, documentCategory: "SHIPMENT_PACKING_SLIP" }] });
        if (document.status !== 200) throw new Error(`Document persistence failed (${document.status}).`);
        const submitted = await request(origin, `/api/portal/inbounds/${inboundId}/status`, token, "POST", { status: "SUBMITTED" });
        if (submitted.status !== 200 || submitted.payload?.inbound?.status !== "SUBMITTED") throw new Error(`Draft submission failed (${submitted.status}).`);
        const reopened = await request(origin, `/api/portal/inbounds/${inboundId}/status`, token, "POST", { status: "DRAFT", reason: "TEST correction" });
        if (reopened.status !== 200 || reopened.payload?.inbound?.status !== "DRAFT") throw new Error(`Return to draft failed (${reopened.status}).`);
        const edited = await request(origin, `/api/portal/inbounds/${inboundId}`, token, "PUT", { fulfillmentLocationId: locationId, referenceNumber: reference, expectedDate: tomorrow, contactName: "Sandbox Test", lines: [{ sku, quantity: 3 }] });
        if (edited.status !== 200 || Number(edited.payload?.inbound?.lines?.[0]?.quantity) !== 3) throw new Error(`Draft edit failed (${edited.status}).`);
        const resubmitted = await request(origin, `/api/portal/inbounds/${inboundId}/status`, token, "POST", { status: "SUBMITTED" });
        if (resubmitted.status !== 200) throw new Error(`Resubmission failed (${resubmitted.status}).`);
        const cancelled = await request(origin, `/api/portal/inbounds/${inboundId}/status`, token, "POST", { status: "CANCELLED", reason: "TEST cleanup" });
        if (cancelled.status !== 200 || cancelled.payload?.inbound?.status !== "CANCELLED") throw new Error(`Cancellation failed (${cancelled.status}).`);
        process.stdout.write(JSON.stringify({ passed: true, company: TEST_COMPANY, workflow: ["DRAFT", "SUBMITTED", "DRAFT", "EDITED", "SUBMITTED", "CANCELLED"], tenantDenialStatus: denied.status }));
    } finally {
        const cleanup = await pool.connect();
        try {
            await cleanup.query("begin");
            await cleanup.query("alter table warehouse_task_history disable trigger warehouse_task_history_immutable");
            await cleanup.query(`delete from warehouse_tasks where source_type='PORTAL_INBOUND' and source_id in
                (select id from portal_inbounds where account_name=$1 and reference_number like 'TEST-INBOUND-DRAFT-%')`, [TEST_COMPANY]);
            await cleanup.query("delete from portal_inbounds where account_name=$1 and reference_number like 'TEST-INBOUND-DRAFT-%'", [TEST_COMPANY]);
            await cleanup.query("delete from activity_log where title like '%TEST-INBOUND-DRAFT-%'");
            await cleanup.query(`delete from portal_sessions where portal_access_id in
                (select id from portal_vendor_access where account_name=$1 and email like 'test-inbound-%@invalid.example')`, [TEST_COMPANY]);
            await cleanup.query("delete from portal_vendor_access where account_name=$1 and email like 'test-inbound-%@invalid.example'", [TEST_COMPANY]);
            await cleanup.query("alter table warehouse_task_history enable trigger warehouse_task_history_immutable");
            if (originalFeatureFlags) await cleanup.query("update owner_accounts set feature_flags=$2::jsonb where id=1510 and name=$1", [TEST_COMPANY, JSON.stringify(originalFeatureFlags)]);
            await cleanup.query("commit");
        } catch (error) { await cleanup.query("rollback").catch(() => {}); throw error; }
        finally { cleanup.release(); await pool.end(); }
    }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
