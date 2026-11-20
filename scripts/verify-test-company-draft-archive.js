"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const { hashToken, requireSandboxConfiguration } = require("./verify-test-company-authenticated-task-scope");

const TEST_COMPANY = Object.freeze({ id: "1510", name: "CODEX PORTAL SYSTEM TEST" });

async function postArchive(origin, orderId, token, requestId) {
    const response = await fetch(`${origin}/api/admin/portal-orders/${orderId}/archive`, {
        method: "POST",
        redirect: "error",
        headers: {
            accept: "application/json",
            cookie: `wms365_app_session=${encodeURIComponent(token)}`,
            origin,
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
            await client.query("delete from access_restriction_log where app_user_id=$1 or request_id like $2", [fixture.userId, `${fixture.prefix}%`]);
            await client.query("delete from app_sessions where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_fulfillment_location_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_user_company_access where app_user_id=$1", [fixture.userId]);
            await client.query("delete from app_users where id=$1", [fixture.userId]);
        }
        if (fixture.orderIds.length) {
            await client.query("delete from warehouse_task_history where task_id in (select id from warehouse_tasks where source_type='PORTAL_ORDER' and source_id=any($1::text[]))", [fixture.orderIds]);
            await client.query("delete from warehouse_tasks where source_type='PORTAL_ORDER' and source_id=any($1::text[])", [fixture.orderIds]);
            await client.query("delete from portal_order_allocations where order_id=any($1::bigint[])", [fixture.orderIds]);
            await client.query("delete from portal_order_lines where order_id=any($1::bigint[])", [fixture.orderIds]);
            await client.query("delete from portal_orders where id=any($1::bigint[])", [fixture.orderIds]);
        }
        await client.query("delete from inventory_transactions where account_name=$1 and sku=$2", [TEST_COMPANY.name, fixture.sku]);
        await client.query("delete from inventory_lines where account_name=$1 and sku=$2", [TEST_COMPANY.name, fixture.sku]);
        await client.query("delete from bin_locations where account_name=$1 and code=$2", [TEST_COMPANY.name, fixture.binCode]);
        await client.query("delete from item_catalog where account_name=$1 and sku=$2", [TEST_COMPANY.name, fixture.sku]);
        await client.query("delete from activity_log where title like $1 or details like $1", [`%${fixture.prefix}%`]);
        if (fixture.locationIds.length) {
            await client.query("delete from company_fulfillment_locations where fulfillment_location_id=any($1::bigint[])", [fixture.locationIds]);
            await client.query("delete from fulfillment_locations where id=any($1::bigint[])", [fixture.locationIds]);
        }
        const residue = await client.query(
            `select
                (select count(*) from portal_orders where order_code like $1)::integer as orders,
                (select count(*) from app_users where email=$2)::integer as users,
                (select count(*) from item_catalog where account_name=$3 and sku=$4)::integer as items,
                (select count(*) from inventory_lines where account_name=$3 and sku=$4)::integer as inventory`,
            [`${fixture.prefix}%`, fixture.email, TEST_COMPANY.name, fixture.sku]
        );
        if (Object.values(residue.rows[0] || {}).some((value) => Number(value) !== 0)) {
            throw new Error("Draft archive fixture cleanup left sandbox residue.");
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
    const runId = crypto.randomBytes(7).toString("hex").toUpperCase();
    const fixture = {
        prefix: `TEST-ARCHIVE-${runId}`,
        email: `test-archive-${runId.toLowerCase()}@invalid.example`,
        sku: `TEST-ARCHIVE-SKU-${runId}`,
        binCode: `TEST-ARCHIVE-BIN-${runId}`,
        userId: null,
        locationIds: [],
        orderIds: [],
        allowedOrderId: "",
        deniedOrderId: "",
        releasedOrderId: ""
    };
    let primaryError = null;
    try {
        const company = await requireDesignatedTestCompany(pool);
        if (company.id !== TEST_COMPANY.id || company.name !== TEST_COMPANY.name) {
            throw new Error("Designated test company identity mismatch.");
        }
        const token = crypto.randomBytes(32).toString("hex");
        const client = await pool.connect();
        try {
            await client.query("begin");
            const identity = await client.query(
                "select id::text from owner_accounts where id=$1 and name=$2 and is_active=true for share",
                [TEST_COMPANY.id, TEST_COMPANY.name]
            );
            if (identity.rowCount !== 1) throw new Error("Designated test company became unavailable before fixture creation.");
            const locations = await client.query(
                `insert into fulfillment_locations (code,name,partner_name,location_type,note,is_active)
                 values ($1,$2,'TEST','OWN_WAREHOUSE',$5,true),($3,$4,'TEST','OWN_WAREHOUSE',$5,true)
                 returning id::text`,
                [`${fixture.prefix}-ALLOW`, `${fixture.prefix} allowed`, `${fixture.prefix}-DENY`, `${fixture.prefix} denied`, fixture.prefix]
            );
            fixture.locationIds = locations.rows.map((row) => row.id);
            const [allowedLocationId, deniedLocationId] = fixture.locationIds;
            await client.query(
                `insert into company_fulfillment_locations
                    (account_name,fulfillment_location_id,is_primary,allow_inbound,allow_outbound,allow_storage,note)
                 values ($1,$2,true,true,true,true,$4),($1,$3,false,true,true,true,$4)`,
                [TEST_COMPANY.name, allowedLocationId, deniedLocationId, fixture.prefix]
            );
            await client.query(
                "insert into item_catalog (account_name,sku,description,tracking_level) values ($1,$2,$3,'CASE')",
                [TEST_COMPANY.name, fixture.sku, `${fixture.prefix} archive fixture`]
            );
            await client.query(
                `insert into bin_locations (code,note,location_type,is_pickable,account_name,fulfillment_location_id)
                 values ($1,$2,'STORAGE',true,$3,$4)`,
                [fixture.binCode, fixture.prefix, TEST_COMPANY.name, allowedLocationId]
            );
            const inventory = await client.query(
                `insert into inventory_lines (account_name,location,sku,tracking_level,quantity)
                 values ($1,$2,$3,'CASE',20) returning id::text`,
                [TEST_COMPANY.name, fixture.binCode, fixture.sku]
            );
            const orders = await client.query(
                `insert into portal_orders (order_code,account_name,status,po_number,order_notes,ship_to_name,fulfillment_location_id)
                 values ($1,$4,'DRAFT',$5,$6,'Sandbox Test Destination',$7),
                        ($2,$4,'DRAFT',$5,$6,'Sandbox Test Destination',$8),
                        ($3,$4,'RELEASED',$5,$6,'Sandbox Test Destination',$7)
                 returning id::text,order_code`,
                [`${fixture.prefix}-ALLOW`, `${fixture.prefix}-DENY`, `${fixture.prefix}-RELEASED`, TEST_COMPANY.name, fixture.prefix, fixture.prefix, allowedLocationId, deniedLocationId]
            );
            const orderByCode = new Map(orders.rows.map((row) => [row.order_code, row.id]));
            fixture.allowedOrderId = orderByCode.get(`${fixture.prefix}-ALLOW`) || "";
            fixture.deniedOrderId = orderByCode.get(`${fixture.prefix}-DENY`) || "";
            fixture.releasedOrderId = orderByCode.get(`${fixture.prefix}-RELEASED`) || "";
            fixture.orderIds = [fixture.allowedOrderId, fixture.deniedOrderId, fixture.releasedOrderId].filter(Boolean);
            if (fixture.orderIds.length !== 3) throw new Error("Draft archive fixture orders were not created exactly once.");
            const lines = await client.query(
                `insert into portal_order_lines (order_id,line_number,sku,requested_quantity)
                 values ($1,1,$4,5),($2,1,$4,7),($3,1,$4,3) returning id::text,order_id::text`,
                [fixture.allowedOrderId, fixture.deniedOrderId, fixture.releasedOrderId, fixture.sku]
            );
            const allowedLineId = lines.rows.find((row) => row.order_id === fixture.allowedOrderId)?.id;
            await client.query(
                `insert into portal_order_allocations
                    (order_id,order_line_id,inventory_line_id,sku,location,tracking_level,allocated_quantity)
                 values ($1,$2,$3,$4,$5,'CASE',5)`,
                [fixture.allowedOrderId, allowedLineId, inventory.rows[0].id, fixture.sku, fixture.binCode]
            );
            const user = await client.query(
                `insert into app_users (email,password_hash,full_name,role,is_active)
                 values ($1,'TEST-NO-PASSWORD-LOGIN',$2,'warehouse_worker',true) returning id::text`,
                [fixture.email, `${fixture.prefix} restricted worker`]
            );
            fixture.userId = user.rows[0].id;
            await client.query("insert into app_user_company_access (app_user_id,account_name) values ($1,$2)", [fixture.userId, TEST_COMPANY.name]);
            await client.query("insert into app_user_fulfillment_location_access (app_user_id,fulfillment_location_id) values ($1,$2)", [fixture.userId, allowedLocationId]);
            await client.query(
                "insert into app_sessions (app_user_id,token_hash,expires_at) values ($1,$2,now()+interval '10 minutes')",
                [fixture.userId, hashToken(token)]
            );
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        const stockBefore = Number((await pool.query(
            "select quantity::numeric from inventory_lines where account_name=$1 and sku=$2",
            [TEST_COMPANY.name, fixture.sku]
        )).rows[0]?.quantity || 0);
        const allowed = await postArchive(config.origin, fixture.allowedOrderId, token, `${fixture.prefix}-ALLOW`);
        if (allowed.status !== 200 || allowed.body?.order?.status !== "ARCHIVED") {
            throw new Error(`Allowed draft archive returned HTTP ${allowed.status}.`);
        }
        const repeated = await postArchive(config.origin, fixture.allowedOrderId, token, `${fixture.prefix}-REPLAY`);
        if (repeated.status !== 200 || repeated.body?.order?.status !== "ARCHIVED") {
            throw new Error("Draft archive replay was not idempotent.");
        }
        const denied = await postArchive(config.origin, fixture.deniedOrderId, token, `${fixture.prefix}-DENIED-WAREHOUSE`);
        if (denied.status !== 403) throw new Error(`Denied-warehouse archive returned HTTP ${denied.status}, expected 403.`);
        const released = await postArchive(config.origin, fixture.releasedOrderId, token, `${fixture.prefix}-RELEASED`);
        if (released.status !== 400) throw new Error(`Released-order archive returned HTTP ${released.status}, expected 400.`);

        const facts = await pool.query(
            `select
                (select status from portal_orders where id=$1)::text as allowed_status,
                (select status from portal_orders where id=$2)::text as denied_status,
                (select status from portal_orders where id=$3)::text as released_status,
                (select count(*) from portal_order_lines where order_id=$1)::integer as allowed_lines,
                (select count(*) from portal_order_allocations where order_id=$1)::integer as allowed_allocations,
                (select quantity::numeric from inventory_lines where account_name=$4 and sku=$5) as stock_after,
                (select count(*) from activity_log where title like $6)::integer as audit_rows`,
            [fixture.allowedOrderId, fixture.deniedOrderId, fixture.releasedOrderId, TEST_COMPANY.name, fixture.sku, `%${fixture.prefix}-ALLOW%`]
        );
        const row = facts.rows[0] || {};
        if (row.allowed_status !== "ARCHIVED" || row.denied_status !== "DRAFT" || row.released_status !== "RELEASED") {
            throw new Error("Draft archive changed an unexpected order status.");
        }
        if (Number(row.allowed_lines) !== 1 || Number(row.allowed_allocations) !== 0) {
            throw new Error("Draft archive did not preserve lines and release allocations.");
        }
        if (Number(row.stock_after) !== stockBefore || Number(row.audit_rows) < 1) {
            throw new Error("Draft archive changed inventory or omitted audit history.");
        }

        console.log(JSON.stringify({
            verified: true,
            designatedCompanyId: TEST_COMPANY.id,
            archivedStatus: row.allowed_status,
            preservedLineCount: Number(row.allowed_lines),
            remainingAllocationCount: Number(row.allowed_allocations),
            inventoryBefore: stockBefore,
            inventoryAfter: Number(row.stock_after),
            idempotentReplay: true,
            deniedWarehouseStatus: denied.status,
            releasedOrderStatus: released.status,
            auditRows: Number(row.audit_rows),
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
