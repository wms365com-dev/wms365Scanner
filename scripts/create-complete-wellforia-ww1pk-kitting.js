const { Pool } = require("pg");
const { completePortalKittingInventory } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const SOURCE_SKU = "TP-WW-6PK-UPC";
const SOURCE_DESCRIPTION = "Whoopsie Wipes 6 Pack";
const SOURCE_CASES = 7;
const SOURCE_PACKS_PER_CASE = 8;
const UNITS_PER_SOURCE_PACK = 6;
const TARGET_SKU = "WW-1PK-UPC";
const TARGET_DESCRIPTION = "Whoopsie Wipes 1 Pack";
const TARGET_CASES = 7;
const TARGET_PACKS_PER_CASE = 48;
const FINISHED_PACKS = SOURCE_CASES * SOURCE_PACKS_PER_CASE * UNITS_PER_SOURCE_PACK;
const WAREHOUSE_ID = 1;
const SOURCE_LOCATION = "GW3PL-MISS-WELLFORIA-BULK";
const DESTINATION_LOCATION = "GW3PL-MISS-WELLFORIA-BULK";
const REFERENCE = "REWORK-TP-WW-6PK-TO-WW-1PK-20260915";
const ACTOR_EMAIL = "k.prathab@gmail.com";
const EMAIL_RECIPIENTS = [
    "usman.tahir@wellforia.com",
    "yudhishter@wellforia.com"
];

function isNonPickableType(value) {
    return ["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE", "RECEIVING_STAGE"]
        .includes(String(value || "").trim().toUpperCase());
}

async function sendCompletionEmail(pool, requestCode) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error("The email provider is not configured; inventory was posted but the completion email was not sent.");
    }
    const deliveryKey = `KITTING-COMPLETED-${requestCode}-WELLFORIA-WW1PK`;
    const existing = await pool.query(
        "select status, message_id, bcc_addresses from email_delivery_log where delivery_key=$1 limit 1",
        [deliveryKey]
    );
    if (existing.rows[0]?.status === "SENT") {
        return {
            sent: true,
            duplicatePrevented: true,
            messageId: existing.rows[0].message_id,
            recipients: existing.rows[0].bcc_addresses
        };
    }

    const subject = `Kitting Request Completed - ${requestCode} - Wellforia`;
    const text = [
        `Kitting request ${requestCode} has been completed for Wellforia.`,
        "",
        `Source used: ${SOURCE_CASES} cases of ${SOURCE_SKU}`,
        `Conversion: ${SOURCE_CASES} cases x ${SOURCE_PACKS_PER_CASE} packs x ${UNITS_PER_SOURCE_PACK} units = ${FINISHED_PACKS} individual packs`,
        `Finished stock: ${TARGET_CASES} cases of ${TARGET_SKU}`,
        `Finished pack: ${TARGET_PACKS_PER_CASE} one-packs per case`,
        `Inventory location: ${DESTINATION_LOCATION} (pickable)`,
        "Packaging: mailers with TP LABEL-WW-1PK-UPC.",
        "",
        "The finished stock is available for orders in WMS365."
    ].join("\n");
    const html = `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px">
<h2 style="color:#1d5068">Kitting request completed</h2>
<p><strong>${requestCode}</strong> has been completed for <strong>Wellforia</strong>.</p>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Source used</td><td style="padding:8px;border:1px solid #d9e2e8">${SOURCE_CASES} cases of ${SOURCE_SKU}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Conversion</td><td style="padding:8px;border:1px solid #d9e2e8">${FINISHED_PACKS} individual packs</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished stock</td><td style="padding:8px;border:1px solid #d9e2e8">${TARGET_CASES} cases of ${TARGET_SKU}, ${TARGET_PACKS_PER_CASE} one-packs per case</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Location</td><td style="padding:8px;border:1px solid #d9e2e8">${DESTINATION_LOCATION} - pickable</td></tr>
</table>
<p>Mailers and <strong>TP LABEL-WW-1PK-UPC</strong> were specified for the finished cases.</p>
<p>The finished stock is available for orders in WMS365.</p>
<p style="color:#657783">This is an automated WMS365 completion notice.</p></div>`;

    const logResult = await pool.query(
        `insert into email_delivery_log (
            status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
            reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
         ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                   'support@wms365.co',$3,$4,'PORTAL_KITTING_STATUS',$5,$6,$7::jsonb)
         on conflict (delivery_key) do update set status='PENDING', error_message='', failed_at=null, updated_at=now()
         returning id`,
        [
            JSON.stringify(["support@wms365.co"]),
            JSON.stringify(EMAIL_RECIPIENTS),
            subject,
            ACCOUNT,
            requestCode,
            deliveryKey,
            JSON.stringify({ sourceSku: SOURCE_SKU, sourceCases: SOURCE_CASES, targetSku: TARGET_SKU, targetCases: TARGET_CASES, finishedPacks: FINISHED_PACKS })
        ]
    );
    const logId = logResult.rows[0].id;
    try {
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": deliveryKey
            },
            body: JSON.stringify({
                from: "WMS365 <support@wms365.co>",
                to: ["support@wms365.co"],
                bcc: EMAIL_RECIPIENTS,
                reply_to: "support@wms365.co",
                subject,
                text,
                html
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await pool.query(
            "update email_delivery_log set status='SENT', message_id=$2, provider_response=$3, sent_at=now(), updated_at=now() where id=$1",
            [logId, payload.id || "", "Resend accepted the message."]
        );
        return { sent: true, messageId: payload.id || "", recipients: EMAIL_RECIPIENTS };
    } catch (error) {
        await pool.query(
            "update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1",
            [logId, String(error.message || error).slice(0, 2000)]
        );
        throw error;
    }
}

async function inspect(pool) {
    const [items, source, target, duplicate, warehouse, actor] = await Promise.all([
        pool.query(
            `select sku, description, tracking_level, uom_label, unit_uom, units_per_case, blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
        ),
        pool.query(
            `select i.id, i.quantity, i.tracking_level, i.lot_number, i.expiration_date,
                    b.is_pickable, b.location_type, b.fulfillment_location_id,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                              join portal_orders o on o.id=a.order_id
                              where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                    + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                                join portal_kitting_requests k on k.id=a.kitting_request_id
                                where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed_quantity
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3 limit 1`,
            [ACCOUNT, SOURCE_SKU, SOURCE_LOCATION]
        ),
        pool.query(
            `select i.id, i.quantity, i.tracking_level, b.is_pickable, b.location_type, b.fulfillment_location_id
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3 limit 1`,
            [ACCOUNT, TARGET_SKU, DESTINATION_LOCATION]
        ),
        pool.query(
            `select id, request_code, status, source_sku, source_quantity, target_sku, target_quantity, completed_at
             from portal_kitting_requests
             where account_name=$1 and purchase_order_reference=$2 order by id desc limit 1`,
            [ACCOUNT, REFERENCE]
        ),
        pool.query(
            `select fl.id, fl.code, fl.name, fl.is_active, cfl.allow_storage,
                    b.is_pickable, b.location_type, b.account_name as bin_account_name
             from fulfillment_locations fl
             join company_fulfillment_locations cfl on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
             join bin_locations b on b.code=$2
             where fl.id=$3`,
            [ACCOUNT, DESTINATION_LOCATION, WAREHOUSE_ID]
        ),
        pool.query(
            "select id, full_name, email from app_users where lower(email)=lower($1) and is_active=true and role='super_admin' limit 1",
            [ACTOR_EMAIL]
        )
    ]);
    return {
        items: items.rows,
        source: source.rows[0] || null,
        target: target.rows[0] || null,
        duplicate: duplicate.rows[0] || null,
        warehouse: warehouse.rows[0] || null,
        actor: actor.rows[0] || null
    };
}

function assertPreflight(state) {
    if (state.items.length !== 2) throw new Error("Both source and finished SKUs must exist in the Wellforia item master.");
    if (state.items.some((item) => item.blocked)) throw new Error("A required SKU is blocked in the Wellforia item master.");
    if (!state.source) throw new Error(`Source stock was not found at ${SOURCE_LOCATION}.`);
    if (state.source.is_pickable !== true || isNonPickableType(state.source.location_type)) throw new Error("The source stock is not in a pickable location.");
    if (String(state.source.fulfillment_location_id) !== String(WAREHOUSE_ID)) throw new Error("The source stock is not assigned to the Mississauga warehouse.");
    if (Number(state.source.quantity) - Number(state.source.committed_quantity) < SOURCE_CASES) throw new Error("There are not enough uncommitted source cases to complete this rework.");
    if (!state.warehouse || state.warehouse.is_active !== true || state.warehouse.allow_storage !== true) throw new Error("Wellforia is not active for storage at the selected warehouse.");
    if (state.warehouse.is_pickable !== true || isNonPickableType(state.warehouse.location_type)) throw new Error("The finished-stock destination is not pickable.");
    if (!state.actor) throw new Error("The authorized platform administrator was not found.");
    if (state.duplicate && state.duplicate.status !== "COMPLETED") throw new Error(`Duplicate request ${state.duplicate.request_code} already exists in ${state.duplicate.status} status.`);
}

async function applyTransaction(pool, before) {
    if (before.duplicate?.status === "COMPLETED") {
        return { requestCode: before.duplicate.request_code, alreadyCompleted: true };
    }
    const client = await pool.connect();
    try {
        await client.query("begin");
        const duplicate = await client.query(
            `select * from portal_kitting_requests where account_name=$1 and purchase_order_reference=$2 limit 1 for update`,
            [ACCOUNT, REFERENCE]
        );
        if (duplicate.rowCount) {
            await client.query("rollback");
            if (duplicate.rows[0].status === "COMPLETED") return { requestCode: duplicate.rows[0].request_code, alreadyCompleted: true };
            throw new Error(`Duplicate request ${duplicate.rows[0].request_code} already exists.`);
        }

        await client.query(
            `update item_catalog set description=$3, tracking_level='CASE', uom_label='Cases',
                    unit_uom='PACK', units_per_case=$4, updated_at=now()
             where account_name=$1 and sku=$2`,
            [ACCOUNT, SOURCE_SKU, SOURCE_DESCRIPTION, SOURCE_PACKS_PER_CASE]
        );
        await client.query(
            `update item_catalog set description=$3, tracking_level='CASE', uom_label='Cases',
                    unit_uom='PACK', units_per_case=$4, updated_at=now()
             where account_name=$1 and sku=$2`,
            [ACCOUNT, TARGET_SKU, TARGET_DESCRIPTION, TARGET_PACKS_PER_CASE]
        );

        const sourceResult = await client.query(
            `select i.*, b.is_pickable, b.location_type, b.fulfillment_location_id
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3 limit 1 for update of i`,
            [ACCOUNT, SOURCE_SKU, SOURCE_LOCATION]
        );
        const source = sourceResult.rows[0];
        if (!source || source.is_pickable !== true || String(source.fulfillment_location_id) !== String(WAREHOUSE_ID)) {
            throw new Error("Source stock changed after review; no inventory was posted.");
        }
        const commitments = await client.query(
            `select
                coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                          join portal_orders o on o.id=a.order_id
                          where a.inventory_line_id=$1 and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                            join portal_kitting_requests k on k.id=a.kitting_request_id
                            where a.inventory_line_id=$1 and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed_quantity`,
            [source.id]
        );
        if (Number(source.quantity) - Number(commitments.rows[0].committed_quantity) < SOURCE_CASES) {
            throw new Error("Source stock was committed after review; no inventory was posted.");
        }

        const components = [{
            sku: SOURCE_SKU,
            totalQuantity: SOURCE_CASES,
            quantityPerUnit: SOURCE_PACKS_PER_CASE,
            description: SOURCE_DESCRIPTION
        }];
        const notes = [
            `${SOURCE_CASES} master cartons x ${SOURCE_PACKS_PER_CASE} six-packs x ${UNITS_PER_SOURCE_PACK} units = ${FINISHED_PACKS} individual one-packs.`,
            `Pack ${TARGET_PACKS_PER_CASE} one-packs in each of ${TARGET_CASES} finished cartons.`,
            "Use mailers and TP LABEL-WW-1PK-UPC."
        ].join(" ");
        const insertResult = await client.query(
            `insert into portal_kitting_requests (
                account_name, portal_access_id, status, sales_order_reference, purchase_order_reference,
                source_sku, source_quantity, components_json, target_sku, target_quantity,
                requested_completion_date, requested_by_name, requested_by_email, notes,
                fulfillment_location_id, processing_business_days, earliest_completion_date, holiday_closures_json
             ) values ($1,null,'SUBMITTED','',$2,$3,$4,$5::jsonb,$6,$7,
                       current_date,$8,$9,$10,$11,4,current_date,'[]'::jsonb)
             returning *`,
            [ACCOUNT, REFERENCE, SOURCE_SKU, SOURCE_CASES, JSON.stringify(components), TARGET_SKU, TARGET_CASES,
                "Usman Tahir", EMAIL_RECIPIENTS[0], notes, WAREHOUSE_ID]
        );
        const requestId = insertResult.rows[0].id;
        const requestCode = `KIT-${String(requestId).padStart(6, "0")}`;
        await client.query("update portal_kitting_requests set request_code=$2, updated_at=now() where id=$1", [requestId, requestCode]);
        const request = { ...insertResult.rows[0], request_code: requestCode };

        await client.query(
            `insert into portal_kitting_allocations (
                kitting_request_id, inventory_line_id, sku, location, lot_number,
                expiration_date, tracking_level, allocated_quantity
             ) values ($1,$2,$3,$4,$5,$6,'CASE',$7)`,
            [requestId, source.id, SOURCE_SKU, SOURCE_LOCATION, source.lot_number || "", source.expiration_date || "", SOURCE_CASES]
        );
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [
                `Submitted kitting request ${requestCode}`,
                `${ACCOUNT} | ${SOURCE_CASES} cases ${SOURCE_SKU} reserved -> ${TARGET_CASES} cases ${TARGET_SKU} | ${FINISHED_PACKS} one-packs | Warehouse Grey Wolf 3PL - Mississauga`
            ]
        );

        const completion = await completePortalKittingInventory(
            client,
            request,
            { destinationLocation: DESTINATION_LOCATION },
            before.actor.full_name || before.actor.email
        );
        const warehouseNote = `${SOURCE_CASES} cases of ${SOURCE_SKU} converted into ${TARGET_CASES} cases of ${TARGET_SKU}. ${FINISHED_PACKS} one-packs total, ${TARGET_PACKS_PER_CASE} per finished case. Mailers and TP LABEL-WW-1PK-UPC specified. Finished stock posted to ${completion.destinationLocation} as pickable inventory.`;
        await client.query(
            `update portal_kitting_requests set status='COMPLETED', warehouse_note=$2,
                    completed_at=now(), completed_by=$3, updated_at=now() where id=$1`,
            [requestId, warehouseNote, before.actor.full_name || before.actor.email]
        );
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [`Updated kitting request ${requestCode} to COMPLETED`, `${ACCOUNT} | ${warehouseNote} | ${before.actor.email}`]
        );
        await client.query("commit");
        return { requestCode, alreadyCompleted: false };
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function verify(pool, before, requestCode) {
    const [request, source, target, ledger, allocation] = await Promise.all([
        pool.query(
            `select request_code, status, source_sku, source_quantity, target_sku, target_quantity,
                    completed_at, completed_by, warehouse_note, notes, fulfillment_location_id
             from portal_kitting_requests where request_code=$1`,
            [requestCode]
        ),
        pool.query("select quantity from inventory_lines where account_name=$1 and sku=$2 and location=$3 limit 1", [ACCOUNT, SOURCE_SKU, SOURCE_LOCATION]),
        pool.query(
            `select i.quantity, i.tracking_level, b.is_pickable, b.location_type, b.fulfillment_location_id
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3 limit 1`,
            [ACCOUNT, TARGET_SKU, DESTINATION_LOCATION]
        ),
        pool.query(
            `select sku, location, transaction_type, quantity_delta, quantity_before, quantity_after
             from inventory_transactions
             where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2 order by id`,
            [ACCOUNT, requestCode]
        ),
        pool.query(
            `select count(*)::int as count from portal_kitting_allocations a
             join portal_kitting_requests k on k.id=a.kitting_request_id where k.request_code=$1`,
            [requestCode]
        )
    ]);
    const row = request.rows[0];
    const targetRow = target.rows[0];
    if (!row || row.status !== "COMPLETED" || row.source_sku !== SOURCE_SKU || Number(row.source_quantity) !== SOURCE_CASES
        || row.target_sku !== TARGET_SKU || Number(row.target_quantity) !== TARGET_CASES
        || targetRow?.is_pickable !== true || isNonPickableType(targetRow?.location_type)
        || String(targetRow?.fulfillment_location_id) !== String(WAREHOUSE_ID)
        || Number(allocation.rows[0]?.count) !== 0 || ledger.rowCount !== 2) {
        throw new Error("Post-completion verification did not reconcile. Review the live transaction immediately.");
    }
    if (!before.duplicate) {
        if (Number(source.rows[0]?.quantity) !== Number(before.source.quantity) - SOURCE_CASES) throw new Error("Source inventory did not decrease by seven cases.");
        if (Number(targetRow.quantity) !== Number(before.target?.quantity || 0) + TARGET_CASES) throw new Error("Finished inventory did not increase by seven cases.");
    }
    const metadata = await pool.query(
        `select sku, description, tracking_level, unit_uom, units_per_case
         from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
        [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
    );
    return {
        request: row,
        source: { location: SOURCE_LOCATION, before: Number(before.source.quantity), used: SOURCE_CASES, after: Number(source.rows[0].quantity) },
        finished: { location: DESTINATION_LOCATION, before: Number(before.target?.quantity || 0), added: TARGET_CASES, after: Number(targetRow.quantity), pickable: targetRow.is_pickable },
        conversion: { individualPacks: FINISHED_PACKS, packsPerFinishedCase: TARGET_PACKS_PER_CASE },
        metadata: metadata.rows,
        ledger: ledger.rows,
        remainingReservations: Number(allocation.rows[0].count)
    };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const before = await inspect(pool);
        assertPreflight(before);
        if (!APPLY) {
            console.log(JSON.stringify({
                mode: "PREVIEW",
                account: ACCOUNT,
                reference: REFERENCE,
                source: {
                    sku: SOURCE_SKU,
                    location: SOURCE_LOCATION,
                    onHandCases: Number(before.source.quantity),
                    committedCases: Number(before.source.committed_quantity),
                    availableCases: Number(before.source.quantity) - Number(before.source.committed_quantity),
                    casesToUse: SOURCE_CASES
                },
                finished: {
                    sku: TARGET_SKU,
                    location: DESTINATION_LOCATION,
                    currentCases: Number(before.target?.quantity || 0),
                    casesToAdd: TARGET_CASES,
                    pickable: before.warehouse.is_pickable
                },
                conversion: { individualPacks: FINISHED_PACKS, packsPerFinishedCase: TARGET_PACKS_PER_CASE },
                itemMasterBefore: before.items,
                emailRecipientsBcc: EMAIL_RECIPIENTS,
                duplicate: before.duplicate
            }, null, 2));
            return;
        }
        const applied = await applyTransaction(pool, before);
        const verified = await verify(pool, before, applied.requestCode);
        const email = await sendCompletionEmail(pool, applied.requestCode);
        console.log(JSON.stringify({ mode: "APPLIED", alreadyCompleted: applied.alreadyCompleted, ...verified, email }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
