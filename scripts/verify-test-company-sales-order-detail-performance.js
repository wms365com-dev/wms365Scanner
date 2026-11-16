"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    hashToken,
    median,
    requireSandboxConfiguration
} = require("./verify-test-company-authenticated-task-scope");

const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });
const DETAIL_MEDIAN_BUDGET_MS = 300;
const DETAIL_MAX_BUDGET_MS = 750;

async function fetchOrder(origin, orderId, token, requestId) {
    const startedAt = process.hrtime.bigint();
    const response = await fetch(`${origin}/api/admin/portal-orders/${encodeURIComponent(orderId)}`, {
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
    return {
        status: response.status,
        body,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6
    };
}

async function cleanup(pool, fixture) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        if (fixture.userId) {
            await client.query(
                "delete from access_restriction_log where app_user_id=$1 or request_id like $2",
                [fixture.userId, `${fixture.requestPrefix}%`]
            );
            await client.query("delete from app_sessions where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_fulfillment_location_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_company_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_users where id=$1", [fixture.userId]);
        }
        if (fixture.orderIds.length) {
            await client.query("delete from portal_orders where id=any($1::bigint[])", [fixture.orderIds]);
        }
        if (fixture.sku) {
            await client.query("delete from item_catalog where account_name=$1 and sku=$2", [TEST_COMPANY.name, fixture.sku]);
        }
        if (fixture.locationIds.length) {
            await client.query("delete from company_fulfillment_locations where fulfillment_location_id=any($1::bigint[])", [fixture.locationIds]);
            await client.query("delete from fulfillment_locations where id=any($1::bigint[])", [fixture.locationIds]);
        }
        const residue = await client.query(
            `select
                (select count(*) from portal_orders where order_code like $1)::integer as orders,
                (select count(*) from item_catalog where account_name=$2 and sku=$3)::integer as items,
                (select count(*) from app_users where id=$4)::integer as users,
                (select count(*) from fulfillment_locations where id=any($5::bigint[]))::integer as locations`,
            [`${fixture.orderPrefix}%`, TEST_COMPANY.name, fixture.sku || "", fixture.userId || 0, fixture.locationIds]
        );
        if (Object.values(residue.rows[0] || {}).some((value) => Number(value) !== 0)) {
            throw new Error("Sales-order detail fixture cleanup left sandbox residue.");
        }
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function cleanupStaleFixtures(pool) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const staleUsers = await client.query(
            "select id from app_users where email like 'test-order-detail-%@invalid.example'"
        );
        const userIds = staleUsers.rows.map((row) => String(row.id));
        if (userIds.length) {
            await client.query(
                "delete from access_restriction_log where app_user_id=any($1::bigint[]) or request_id like 'TEST-ORDER-DETAIL-%'",
                [userIds]
            );
            await client.query("delete from app_sessions where app_user_id=any($1::bigint[])", [userIds]);
            await client.query("delete from app_user_fulfillment_location_access where app_user_id=any($1::bigint[])", [userIds]);
            await client.query("delete from app_user_company_access where app_user_id=any($1::bigint[])", [userIds]);
            await client.query("delete from app_users where id=any($1::bigint[])", [userIds]);
        }
        await client.query("delete from portal_orders where order_code like 'TEST-ORDER-DETAIL-%'");
        await client.query("delete from item_catalog where account_name=$1 and sku like 'TEST-DETAIL-%'", [TEST_COMPANY.name]);
        const staleLocations = await client.query(
            "select id from fulfillment_locations where code like 'TEST-DETAIL-ALLOW-%' or code like 'TEST-DETAIL-DENY-%'"
        );
        const locationIds = staleLocations.rows.map((row) => String(row.id));
        if (locationIds.length) {
            await client.query("delete from company_fulfillment_locations where fulfillment_location_id=any($1::bigint[])", [locationIds]);
            await client.query("delete from fulfillment_locations where id=any($1::bigint[])", [locationIds]);
        }
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

function assertAllowedOrder(response, fixture) {
    if (response.status !== 200) {
        throw new Error(`Allowed sales-order detail request returned HTTP ${response.status}.`);
    }
    const order = response.body?.order;
    if (!order || String(order.id) !== fixture.allowedOrderId || order.orderCode !== fixture.allowedOrderCode) {
        throw new Error("Allowed sales-order detail response did not contain the exact fixture order.");
    }
    if (order.accountName !== TEST_COMPANY.name || order.status !== "DRAFT") {
        throw new Error("Allowed sales-order detail response changed company or status scope.");
    }
    if (String(order.fulfillmentLocationId) !== fixture.allowedLocationId) {
        throw new Error("Allowed sales-order detail response changed warehouse scope.");
    }
    if (!Array.isArray(order.lines) || order.lines.length !== 1
        || order.lines[0].sku !== fixture.sku || Number(order.lines[0].quantity) !== 7) {
        throw new Error("Allowed sales-order detail response changed line content.");
    }
    if (!Array.isArray(order.documents) || !Array.isArray(order.warehouseShipments)
        || !Array.isArray(order.shipmentTracking)) {
        throw new Error("Allowed sales-order detail response omitted required detail collections.");
    }
}

async function main(env = process.env) {
    const config = requireSandboxConfiguration(env);
    const pool = new Pool({ connectionString: config.connectionString, max: 3 });
    const runId = crypto.randomBytes(8).toString("hex").toUpperCase();
    const fixture = {
        orderPrefix: `TEST-ORDER-DETAIL-${runId}-`,
        requestPrefix: `TEST-ORDER-DETAIL-${runId}`,
        sku: `TEST-DETAIL-${runId}`,
        locationIds: [],
        orderIds: [],
        userId: null,
        allowedLocationId: "",
        deniedLocationId: "",
        allowedOrderId: "",
        deniedOrderId: "",
        allowedOrderCode: `TEST-ORDER-DETAIL-${runId}-ALLOW`,
        deniedOrderCode: `TEST-ORDER-DETAIL-${runId}-DENY`
    };
    let primaryError = null;
    try {
        const company = await requireDesignatedTestCompany(pool);
        if (company.id !== TEST_COMPANY.id || company.name !== TEST_COMPANY.name) {
            throw new Error("Designated test company identity mismatch.");
        }
        await cleanupStaleFixtures(pool);

        const client = await pool.connect();
        let sessionToken;
        try {
            await client.query("begin");
            const identity = await client.query(
                "select id::text,name,is_active from owner_accounts where id=$1 and name=$2 and is_active=true for share",
                [TEST_COMPANY.id, TEST_COMPANY.name]
            );
            if (identity.rowCount !== 1) throw new Error("Designated test company became unavailable before fixture creation.");

            const locations = await client.query(
                `insert into fulfillment_locations (code,name,partner_name,location_type,note,is_active)
                 values ($1,$2,'TEST','OWN_WAREHOUSE',$4,true),($3,$5,'TEST','OWN_WAREHOUSE',$4,true)
                 returning id::text`,
                [
                    `TEST-DETAIL-ALLOW-${runId}`, `Test Detail Allowed ${runId}`,
                    `TEST-DETAIL-DENY-${runId}`, fixture.orderPrefix,
                    `Test Detail Denied ${runId}`
                ]
            );
            fixture.locationIds = locations.rows.map((row) => row.id);
            [fixture.allowedLocationId, fixture.deniedLocationId] = fixture.locationIds;
            await client.query(
                `insert into company_fulfillment_locations
                    (account_name,fulfillment_location_id,is_primary,allow_inbound,allow_outbound,allow_storage,note)
                 values ($1,$2,true,true,true,true,$4),($1,$3,false,true,true,true,$4)`,
                [TEST_COMPANY.name, fixture.allowedLocationId, fixture.deniedLocationId, fixture.orderPrefix]
            );
            await client.query(
                `insert into item_catalog (account_name,sku,description,tracking_level)
                 values ($1,$2,'Sandbox sales-order detail performance fixture','CASE')`,
                [TEST_COMPANY.name, fixture.sku]
            );
            const orders = await client.query(
                `insert into portal_orders
                    (order_code,account_name,status,po_number,order_notes,ship_to_name,fulfillment_location_id)
                 values ($1,$3,'DRAFT',$4,$5,'Sandbox Test Destination',$6),
                        ($2,$3,'DRAFT',$4,$5,'Sandbox Test Destination',$7)
                 returning id::text,order_code`,
                [
                    fixture.allowedOrderCode, fixture.deniedOrderCode, TEST_COMPANY.name,
                    `${fixture.orderPrefix}PO`, "Sandbox-only authenticated detail fixture",
                    fixture.allowedLocationId, fixture.deniedLocationId
                ]
            );
            const orderByCode = new Map(orders.rows.map((row) => [row.order_code, row.id]));
            fixture.allowedOrderId = orderByCode.get(fixture.allowedOrderCode) || "";
            fixture.deniedOrderId = orderByCode.get(fixture.deniedOrderCode) || "";
            fixture.orderIds = [fixture.allowedOrderId, fixture.deniedOrderId].filter(Boolean);
            if (fixture.orderIds.length !== 2) throw new Error("Sales-order detail fixture orders were not created exactly once.");
            await client.query(
                `insert into portal_order_lines (order_id,line_number,sku,requested_quantity)
                 values ($1,1,$3,7),($2,1,$3,11)`,
                [fixture.allowedOrderId, fixture.deniedOrderId, fixture.sku]
            );
            const user = await client.query(
                `insert into app_users (email,password_hash,full_name,role,is_active)
                 values ($1,$2,$3,'warehouse_worker',true) returning id::text`,
                [`test-order-detail-${runId.toLowerCase()}@invalid.example`, "TEST-NO-PASSWORD-LOGIN", `${fixture.orderPrefix} restricted worker`]
            );
            fixture.userId = user.rows[0].id;
            await client.query(
                "insert into app_user_company_access (app_user_id,account_name) values ($1,$2)",
                [fixture.userId, TEST_COMPANY.name]
            );
            await client.query(
                "insert into app_user_fulfillment_location_access (app_user_id,fulfillment_location_id) values ($1,$2)",
                [fixture.userId, fixture.allowedLocationId]
            );
            sessionToken = crypto.randomBytes(32).toString("hex");
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

        const measurements = [];
        for (let iteration = 0; iteration < 7; iteration += 1) {
            const response = await fetchOrder(
                config.origin,
                fixture.allowedOrderId,
                sessionToken,
                `${fixture.requestPrefix}-ALLOW-${iteration + 1}`
            );
            assertAllowedOrder(response, fixture);
            if (iteration > 0) measurements.push(response.elapsedMs);
        }
        const denied = await fetchOrder(
            config.origin,
            fixture.deniedOrderId,
            sessionToken,
            `${fixture.requestPrefix}-DENY`
        );
        if (denied.status !== 403) {
            throw new Error(`Denied-warehouse sales-order detail request returned HTTP ${denied.status}, expected 403.`);
        }

        const detailMedianMs = median(measurements);
        const detailMaxMs = Math.max(...measurements);
        if (detailMedianMs > DETAIL_MEDIAN_BUDGET_MS || detailMaxMs > DETAIL_MAX_BUDGET_MS) {
            throw new Error(
                `Authenticated sales-order detail exceeded its sandbox budget `
                + `(median ${detailMedianMs.toFixed(1)}ms, max ${detailMaxMs.toFixed(1)}ms).`
            );
        }

        console.log(JSON.stringify({
            verified: true,
            designatedCompanyId: TEST_COMPANY.id,
            allowedWarehouseStatus: 200,
            deniedWarehouseStatus: denied.status,
            samples: measurements.length,
            salesOrderDetailMedianMs: Number(detailMedianMs.toFixed(1)),
            salesOrderDetailMaxMs: Number(detailMaxMs.toFixed(1)),
            cleanupPending: true
        }));
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
        console.error(JSON.stringify({
            verified: false,
            error: error.message,
            cleanupError: error.cleanupError?.message || ""
        }));
        process.exitCode = 1;
    });
}

module.exports = {
    DETAIL_MAX_BUDGET_MS,
    DETAIL_MEDIAN_BUDGET_MS,
    assertAllowedOrder,
    main
};
