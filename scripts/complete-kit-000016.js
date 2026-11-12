const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const REQUEST_CODE = "KIT-000016";
const ACCOUNT = "HEALTEA";
const SOURCE_SKU = "20628693486143";
const SOURCE_QUANTITY = 6;
const TARGET_SKU = "628693486149";
const TARGET_QUANTITY = 36;
const DESTINATION_LOCATION = "HEALTEA-BULK";

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    try {
        const requestResult = await pool.query(
            `select * from portal_kitting_requests where request_code = $1 limit 1`,
            [REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found.`);
        const request = requestResult.rows[0];
        if (request.account_name !== ACCOUNT
            || request.source_sku !== SOURCE_SKU
            || Number(request.source_quantity) !== SOURCE_QUANTITY
            || request.target_sku !== TARGET_SKU
            || Number(request.target_quantity) !== TARGET_QUANTITY) {
            throw new Error(`${REQUEST_CODE} no longer matches the reviewed HEALTEA conversion.`);
        }
        if (request.status === "COMPLETED") {
            console.log(JSON.stringify({ alreadyCompleted: true, requestCode: REQUEST_CODE }, null, 2));
            return;
        }
        if (!["SUBMITTED", "IN_PROGRESS"].includes(request.status)) {
            throw new Error(`${REQUEST_CODE} is ${request.status} and cannot be completed.`);
        }

        const allocationResult = await pool.query(
            `select a.*, i.quantity as on_hand_quantity, b.is_pickable, b.location_type
             from portal_kitting_allocations a
             join inventory_lines i on i.id = a.inventory_line_id
             join bin_locations b on b.code = a.location
             where a.kitting_request_id = $1
             order by a.id`,
            [request.id]
        );
        if (allocationResult.rowCount !== 1) throw new Error("The reviewed component reservation is missing or has changed.");
        const allocation = allocationResult.rows[0];
        if (allocation.sku !== SOURCE_SKU
            || Number(allocation.allocated_quantity) !== SOURCE_QUANTITY
            || Number(allocation.on_hand_quantity) < SOURCE_QUANTITY
            || allocation.is_pickable !== true
            || ["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE", "RECEIVING_STAGE"].includes(String(allocation.location_type || "").toUpperCase())) {
            throw new Error("The component reservation is no longer valid or pickable.");
        }

        const destinationResult = await pool.query(
            `select b.code, b.is_pickable, b.location_type,
                    coalesce(i.quantity, 0) as target_quantity_before
             from bin_locations b
             left join inventory_lines i
               on i.account_name = $1 and i.location = b.code and i.sku = $2
             where b.code = $3
             limit 1`,
            [ACCOUNT, TARGET_SKU, DESTINATION_LOCATION]
        );
        if (destinationResult.rowCount !== 1) throw new Error("The finished-item destination does not exist.");
        const destination = destinationResult.rows[0];
        if (destination.is_pickable !== true
            || ["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE", "RECEIVING_STAGE"].includes(String(destination.location_type || "").toUpperCase())) {
            throw new Error("The finished-item destination is not pickable storage.");
        }

        const adminResult = await pool.query(
            `select id, email, full_name from app_users
             where lower(email) = lower($1) and is_active = true and role = 'super_admin'
             limit 1`,
            ["k.prathab@gmail.com"]
        );
        if (adminResult.rowCount !== 1) throw new Error("The authorized platform administrator was not found.");
        const admin = adminResult.rows[0];
        const token = crypto.randomBytes(32).toString("hex");
        const sessionResult = await pool.query(
            `insert into app_sessions (app_user_id, token_hash, expires_at)
             values ($1, $2, now() + interval '10 minutes') returning id`,
            [admin.id, hashToken(token)]
        );
        sessionId = sessionResult.rows[0].id;

        const response = await fetch(`${API_ORIGIN}/api/admin/kitting-requests/${request.id}/status`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Cookie: `wms365_app_session=${encodeURIComponent(token)}`
            },
            body: JSON.stringify({
                status: "COMPLETED",
                destinationLocation: DESTINATION_LOCATION,
                warehouseNote: "Physical kitting confirmed complete. Finished stock posted to pickable inventory."
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success !== true) {
            throw new Error(`WMS365 completion failed (${response.status}): ${payload.error || payload.message || "request failed"}`);
        }

        const verificationResult = await pool.query(
            `select status, completed_at, completed_by, warehouse_note
             from portal_kitting_requests where id = $1`,
            [request.id]
        );
        const sourceAfterResult = await pool.query(
            `select quantity from inventory_lines where id = $1`,
            [allocation.inventory_line_id]
        );
        const targetAfterResult = await pool.query(
            `select i.quantity, i.tracking_level, b.is_pickable, b.location_type
             from inventory_lines i
             join bin_locations b on b.code = i.location
             where i.account_name = $1 and i.sku = $2 and i.location = $3
             limit 1`,
            [ACCOUNT, TARGET_SKU, DESTINATION_LOCATION]
        );
        const remainingAllocationResult = await pool.query(
            `select count(*)::int as count from portal_kitting_allocations where kitting_request_id = $1`,
            [request.id]
        );
        const ledgerResult = await pool.query(
            `select sku, location, transaction_type, quantity_delta, quantity_before, quantity_after, source_type, source_id
             from inventory_transactions
             where account_name = $1 and source_type = 'PORTAL_KITTING_REQUEST' and source_id = $2
             order by id`,
            [ACCOUNT, REQUEST_CODE]
        );

        const completed = verificationResult.rows[0];
        const sourceAfter = Number(sourceAfterResult.rows[0]?.quantity);
        const targetAfter = targetAfterResult.rows[0];
        const expectedSourceAfter = Number(allocation.on_hand_quantity) - SOURCE_QUANTITY;
        const expectedTargetAfter = Number(destination.target_quantity_before) + TARGET_QUANTITY;
        if (completed.status !== "COMPLETED"
            || sourceAfter !== expectedSourceAfter
            || Number(targetAfter?.quantity) !== expectedTargetAfter
            || targetAfter?.is_pickable !== true
            || Number(remainingAllocationResult.rows[0]?.count) !== 0
            || ledgerResult.rowCount !== 2) {
            throw new Error("Post-completion verification did not reconcile. Review the live transaction immediately.");
        }

        console.log(JSON.stringify({
            requestCode: REQUEST_CODE,
            status: completed.status,
            completedAt: completed.completed_at,
            completedBy: completed.completed_by,
            source: {
                sku: SOURCE_SKU,
                location: allocation.location,
                before: Number(allocation.on_hand_quantity),
                deducted: SOURCE_QUANTITY,
                after: sourceAfter
            },
            finished: {
                sku: TARGET_SKU,
                location: DESTINATION_LOCATION,
                before: Number(destination.target_quantity_before),
                added: TARGET_QUANTITY,
                after: Number(targetAfter.quantity),
                trackingLevel: targetAfter.tracking_level,
                pickable: targetAfter.is_pickable,
                locationType: targetAfter.location_type
            },
            remainingReservations: Number(remainingAllocationResult.rows[0].count),
            ledgerEntries: ledgerResult.rows
        }, null, 2));
    } finally {
        if (sessionId) {
            await pool.query("delete from app_sessions where id = $1", [sessionId]).catch(() => {});
        }
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
