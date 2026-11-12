const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const REQUEST_CODE = "KIT-000018";
const ACCOUNT = "HEALTEA";
const DESTINATION_LOCATION = "GW3PL-MISS-HEALTEA-BULK";
const TARGET_SKU = "30628693486072";
const TARGET_QUANTITY = 40;
const EXPECTED_COMPONENTS = new Map([
    ["20628693486167", 20],
    ["TRAY12", 120]
]);

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function isNonPickableType(value) {
    return ["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE", "RECEIVING_STAGE"]
        .includes(String(value || "").trim().toUpperCase());
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    try {
        const requestResult = await pool.query(
            "select * from portal_kitting_requests where request_code=$1 limit 1",
            [REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found.`);
        const request = requestResult.rows[0];
        if (request.account_name !== ACCOUNT
            || request.target_sku !== TARGET_SKU
            || Number(request.target_quantity) !== TARGET_QUANTITY) {
            throw new Error(`${REQUEST_CODE} no longer matches the reviewed Healtea conversion.`);
        }

        const targetBeforeResult = await pool.query(
            `select i.id, i.quantity, i.tracking_level, b.is_pickable, b.location_type,
                    b.fulfillment_location_id
             from inventory_lines i
             join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3
             limit 1`,
            [ACCOUNT, TARGET_SKU, DESTINATION_LOCATION]
        );
        if (targetBeforeResult.rowCount !== 1) throw new Error("The reviewed finished-item inventory line is missing.");
        const targetBefore = targetBeforeResult.rows[0];
        if (targetBefore.is_pickable !== true || isNonPickableType(targetBefore.location_type)) {
            throw new Error("The finished-item destination is not pickable storage.");
        }

        if (request.status === "COMPLETED") {
            console.log(JSON.stringify({
                alreadyCompleted: true,
                requestCode: REQUEST_CODE,
                finished: {
                    sku: TARGET_SKU,
                    location: DESTINATION_LOCATION,
                    quantity: Number(targetBefore.quantity),
                    pickable: targetBefore.is_pickable
                }
            }, null, 2));
            return;
        }
        if (!["SUBMITTED", "IN_PROGRESS"].includes(request.status)) {
            throw new Error(`${REQUEST_CODE} is ${request.status} and cannot be completed.`);
        }

        const allocationsResult = await pool.query(
            `select a.id, a.inventory_line_id, a.sku, a.location, a.allocated_quantity,
                    i.quantity as on_hand_quantity, b.is_pickable, b.location_type,
                    b.fulfillment_location_id
             from portal_kitting_allocations a
             join inventory_lines i on i.id=a.inventory_line_id
             join bin_locations b on b.code=a.location
             where a.kitting_request_id=$1
             order by a.id`,
            [request.id]
        );
        if (allocationsResult.rowCount !== EXPECTED_COMPONENTS.size) {
            throw new Error("The reviewed component reservations are missing or have changed.");
        }
        const beforeByInventoryId = new Map();
        for (const allocation of allocationsResult.rows) {
            const expectedQuantity = EXPECTED_COMPONENTS.get(allocation.sku);
            if (!expectedQuantity
                || Number(allocation.allocated_quantity) !== expectedQuantity
                || Number(allocation.on_hand_quantity) < expectedQuantity
                || allocation.is_pickable !== true
                || isNonPickableType(allocation.location_type)
                || String(allocation.fulfillment_location_id) !== String(targetBefore.fulfillment_location_id)) {
                throw new Error(`The reservation for ${allocation.sku} is no longer valid for completion.`);
            }
            beforeByInventoryId.set(String(allocation.inventory_line_id), Number(allocation.on_hand_quantity));
        }

        const adminResult = await pool.query(
            `select id from app_users
             where lower(email)=lower($1) and is_active=true and role='super_admin'
             limit 1`,
            ["k.prathab@gmail.com"]
        );
        if (adminResult.rowCount !== 1) throw new Error("The authorized platform administrator was not found.");
        const token = crypto.randomBytes(32).toString("hex");
        const sessionResult = await pool.query(
            `insert into app_sessions (app_user_id, token_hash, expires_at)
             values ($1,$2,now() + interval '10 minutes') returning id`,
            [adminResult.rows[0].id, hashToken(token)]
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

        await new Promise((resolve) => setTimeout(resolve, 5000));
        const verificationResult = await pool.query(
            "select status, completed_at, completed_by, warehouse_note from portal_kitting_requests where id=$1",
            [request.id]
        );
        const componentAfterResult = await pool.query(
            `select id, sku, location, quantity from inventory_lines
             where id=any($1::bigint[]) order by id`,
            [[...beforeByInventoryId.keys()]]
        );
        const targetAfterResult = await pool.query(
            `select i.quantity, i.tracking_level, b.is_pickable, b.location_type
             from inventory_lines i
             join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3
             limit 1`,
            [ACCOUNT, TARGET_SKU, DESTINATION_LOCATION]
        );
        const remainingResult = await pool.query(
            "select count(*)::int as count from portal_kitting_allocations where kitting_request_id=$1",
            [request.id]
        );
        const ledgerResult = await pool.query(
            `select sku, location, transaction_type, quantity_delta, quantity_before, quantity_after
             from inventory_transactions
             where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2
             order by id`,
            [ACCOUNT, REQUEST_CODE]
        );
        const emailResult = await pool.query(
            `select status, subject, bcc_addresses, message_id, sent_at
             from email_delivery_log
             where source_type='PORTAL_KITTING_STATUS' and source_ref=$1
             order by id desc limit 1`,
            [REQUEST_CODE]
        );

        const completed = verificationResult.rows[0];
        const targetAfter = targetAfterResult.rows[0];
        const expectedTargetAfter = Number(targetBefore.quantity) + TARGET_QUANTITY;
        for (const row of componentAfterResult.rows) {
            const expectedAfter = beforeByInventoryId.get(String(row.id)) - EXPECTED_COMPONENTS.get(row.sku);
            if (Number(row.quantity) !== expectedAfter) {
                throw new Error(`Post-completion quantity for ${row.sku} did not reconcile.`);
            }
        }
        if (completed.status !== "COMPLETED"
            || Number(targetAfter?.quantity) !== expectedTargetAfter
            || targetAfter?.is_pickable !== true
            || Number(remainingResult.rows[0]?.count) !== 0
            || ledgerResult.rowCount !== 3) {
            throw new Error("Post-completion verification did not reconcile. Review the live transaction immediately.");
        }

        console.log(JSON.stringify({
            requestCode: REQUEST_CODE,
            status: completed.status,
            completedAt: completed.completed_at,
            completedBy: completed.completed_by,
            components: allocationsResult.rows.map((allocation) => ({
                sku: allocation.sku,
                location: allocation.location,
                before: Number(allocation.on_hand_quantity),
                deducted: Number(allocation.allocated_quantity),
                after: Number(allocation.on_hand_quantity) - Number(allocation.allocated_quantity)
            })),
            finished: {
                sku: TARGET_SKU,
                location: DESTINATION_LOCATION,
                before: Number(targetBefore.quantity),
                added: TARGET_QUANTITY,
                after: Number(targetAfter.quantity),
                trackingLevel: targetAfter.tracking_level,
                pickable: targetAfter.is_pickable,
                locationType: targetAfter.location_type
            },
            remainingReservations: Number(remainingResult.rows[0].count),
            ledgerEntries: ledgerResult.rows,
            completionEmail: emailResult.rows[0] || null
        }, null, 2));
    } finally {
        if (sessionId) await pool.query("delete from app_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
