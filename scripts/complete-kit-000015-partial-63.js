const { Pool } = require("pg");

const ACCOUNT = "HEALTEA";
const REQUEST_CODE = "KIT-000015";
const TARGET_SKU = "628693486408";
const TARGET_QUANTITY = 63;
const TARGET_LOCATION = "HEALTEA-BULK";
const WIP_LOCATION = "HEALTEA-KIT-WIP";
const BOX_SKU = "EB4MP";
const BOX_QUANTITY = 63;
const SOURCE_CASES = 3;
const LOOSE_CANS_PER_FLAVOUR = 9;
const ACTOR_EMAIL = "k.prathab@gmail.com";
const CUSTOMER_EMAIL = "commande@thehealtea.com";
const COMPONENTS = [
    { sku: "20628693486136", wipSku: "KIT-WIP-86136-EA", description: "Kitting WIP - Peppermint & Dandelion single can" },
    { sku: "20628693486143", wipSku: "KIT-WIP-86143-EA", description: "Kitting WIP - Ginger & Chamomile single can" },
    { sku: "20628693486150", wipSku: "KIT-WIP-86150-EA", description: "Kitting WIP - Nettle & Rosemary single can" },
    { sku: "20628693486167", wipSku: "KIT-WIP-86167-EA", description: "Kitting WIP - Hibiscus & Mango single can" }
];

async function addLedger(client, input) {
    await client.query(
        `insert into inventory_transactions (
            account_name, warehouse_id, fulfillment_location_id, location, sku, upc,
            lot_number, expiration_date, transaction_type, quantity_delta,
            quantity_before, quantity_after, source_type, source_id, user_id,
            device_id, idempotency_key, source, server_timestamp
         ) values ($1,'',null,$2,$3,$4,$5,$6,'CONVERSION',$7,$8,$9,
                   'PORTAL_KITTING_REQUEST',$10,$11,'',$12,'kitting_partial_completion',now())
         on conflict (idempotency_key, transaction_type, source_type, location, sku)
         where idempotency_key <> '' do nothing`,
        [
            ACCOUNT, input.location, input.sku, input.upc || "", input.lotNumber || "",
            input.expirationDate || "", input.delta, input.before, input.after,
            REQUEST_CODE, input.userId, input.idempotencyKey
        ]
    );
}

async function addInventory(client, { sku, location, quantity, trackingLevel, lotNumber = "", expirationDate = "", upc = "", userId, key }) {
    const beforeResult = await client.query(
        `select * from inventory_lines
         where account_name=$1 and location=$2 and sku=$3 and lot_number=$4 and expiration_date=$5
         limit 1 for update`,
        [ACCOUNT, location, sku, lotNumber, expirationDate]
    );
    const before = Number(beforeResult.rows[0]?.quantity || 0);
    const after = before + quantity;
    if (beforeResult.rowCount) {
        await client.query("update inventory_lines set quantity=$2, updated_at=now() where id=$1", [beforeResult.rows[0].id, after]);
    } else {
        await client.query(
            `insert into inventory_lines (account_name, location, sku, upc, lot_number, expiration_date, quantity, tracking_level)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ACCOUNT, location, sku, upc, lotNumber, expirationDate, after, trackingLevel]
        );
    }
    await addLedger(client, {
        location, sku, upc, lotNumber, expirationDate, delta: quantity, before, after,
        userId, idempotencyKey: key
    });
    return { before, after };
}

async function sendCompletionEmail(pool) {
    if (!process.env.RESEND_API_KEY) return { sent: false, reason: "email-provider-not-configured" };
    const deliveryKey = "KITTING-COMPLETED-KIT-000015-63-20260910";
    const subject = `Kitting Request Completed - ${REQUEST_CODE}`;
    const text = [
        `Kitting request ${REQUEST_CODE} has been completed.`,
        `Company: ${ACCOUNT}`,
        `Finished SKU: ${TARGET_SKU}`,
        `Completed quantity: ${TARGET_QUANTITY} variety packs`,
        `Finished stock location: ${TARGET_LOCATION} (pickable)`,
        "The remaining loose cans are recorded in a non-pickable kitting work-in-process location.",
        "",
        "This is an automated WMS365 completion notice."
    ].join("\n");
    const html = `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px">
<h2 style="color:#1d5068">Kitting request completed</h2>
<p><strong>${REQUEST_CODE}</strong> has been completed for <strong>${ACCOUNT}</strong>.</p>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Finished SKU</td><td style="padding:8px;border:1px solid #d9e2e8">${TARGET_SKU}</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Completed quantity</td><td style="padding:8px;border:1px solid #d9e2e8">${TARGET_QUANTITY} variety packs</td></tr>
<tr><td style="padding:8px;border:1px solid #d9e2e8;font-weight:700">Stock location</td><td style="padding:8px;border:1px solid #d9e2e8">${TARGET_LOCATION} - pickable</td></tr>
</table>
<p>The remaining loose cans are recorded in a non-pickable kitting work-in-process location.</p>
<p style="color:#657783">This is an automated WMS365 completion notice.</p></div>`;

    const existing = await pool.query("select status, message_id from email_delivery_log where delivery_key=$1", [deliveryKey]);
    if (existing.rows[0]?.status === "SENT") return { sent: true, duplicatePrevented: true, messageId: existing.rows[0].message_id };
    const logResult = await pool.query(
        `insert into email_delivery_log (
            status, provider, from_address, to_addresses, cc_addresses, bcc_addresses,
            reply_to, subject, account_name, source_type, source_ref, delivery_key, metadata
         ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                   'support@wms365.co',$3,$4,'PORTAL_KITTING_REQUEST',$5,$6,$7::jsonb)
         on conflict (delivery_key) do update set status='PENDING', error_message='', failed_at=null, updated_at=now()
         returning id`,
        [JSON.stringify(["support@wms365.co"]), JSON.stringify([CUSTOMER_EMAIL]), subject, ACCOUNT, REQUEST_CODE, deliveryKey,
            JSON.stringify({ completedQuantity: TARGET_QUANTITY, destinationLocation: TARGET_LOCATION, partialPhysicalCompletion: true })]
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
                bcc: [CUSTOMER_EMAIL],
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
        return { sent: true, messageId: payload.id || "" };
    } catch (error) {
        await pool.query(
            "update email_delivery_log set status='FAILED', error_message=$2, failed_at=now(), updated_at=now() where id=$1",
            [logId, String(error.message || error).slice(0, 2000)]
        );
        return { sent: false, reason: error.message || String(error) };
    }
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    let result;
    try {
        await client.query("begin");
        const requestResult = await client.query(
            "select * from portal_kitting_requests where request_code=$1 limit 1 for update",
            [REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found.`);
        const request = requestResult.rows[0];
        if (request.account_name !== ACCOUNT || request.target_sku !== TARGET_SKU) throw new Error("The request no longer matches the reviewed Healtea variety-pack build.");
        if (request.status === "COMPLETED") {
            await client.query("rollback");
            console.log(JSON.stringify({ alreadyCompleted: true, requestCode: REQUEST_CODE }, null, 2));
            return;
        }
        if (!["SUBMITTED", "IN_PROGRESS"].includes(request.status)) throw new Error(`${REQUEST_CODE} is ${request.status} and cannot be completed.`);
        if (Number(request.target_quantity) !== 144) throw new Error("The original planned quantity is no longer 144; stopping for review.");

        const adminResult = await client.query(
            "select id, full_name, email from app_users where lower(email)=lower($1) and is_active=true and role='super_admin' limit 1",
            [ACTOR_EMAIL]
        );
        if (adminResult.rowCount !== 1) throw new Error("The authorized platform administrator was not found.");
        const admin = adminResult.rows[0];

        const allocationsResult = await client.query(
            `select a.*, i.quantity as on_hand_quantity, i.upc, i.tracking_level,
                    b.is_pickable, b.location_type
             from portal_kitting_allocations a
             join inventory_lines i on i.id=a.inventory_line_id
             join bin_locations b on b.code=a.location
             where a.kitting_request_id=$1 order by a.id for update of i, a`,
            [request.id]
        );
        if (allocationsResult.rowCount !== 5) throw new Error("The reviewed five component reservations are missing or changed.");
        const allocationBySku = new Map(allocationsResult.rows.map((row) => [row.sku, row]));
        for (const component of COMPONENTS) {
            const allocation = allocationBySku.get(component.sku);
            if (!allocation || Number(allocation.allocated_quantity) !== 6 || Number(allocation.on_hand_quantity) < SOURCE_CASES || allocation.is_pickable !== true) {
                throw new Error(`The reservation for ${component.sku} is no longer valid.`);
            }
        }
        const boxAllocation = allocationBySku.get(BOX_SKU);
        if (!boxAllocation || Number(boxAllocation.allocated_quantity) !== 132 || Number(boxAllocation.on_hand_quantity) < BOX_QUANTITY || boxAllocation.is_pickable !== true) {
            throw new Error("The empty-box reservation is no longer valid.");
        }

        const targetBinResult = await client.query("select * from bin_locations where code=$1 limit 1", [TARGET_LOCATION]);
        if (targetBinResult.rowCount !== 1 || targetBinResult.rows[0].is_pickable !== true) throw new Error("The finished-item destination is not pickable.");
        await client.query(
            `insert into bin_locations (code, note, location_type, is_pickable, account_name)
             values ($1,$2,'HOLD',false,$3)
             on conflict (code) do update set note=excluded.note, location_type='HOLD', is_pickable=false,
                 account_name=excluded.account_name, updated_at=now()`,
            [WIP_LOCATION, "Healtea kitting work-in-process; loose components are not available for sales orders.", ACCOUNT]
        );

        const actualComponents = [];
        const sourceChanges = [];
        const wipChanges = [];
        for (const component of COMPONENTS) {
            const allocation = allocationBySku.get(component.sku);
            const before = Number(allocation.on_hand_quantity);
            const after = before - SOURCE_CASES;
            await client.query("update inventory_lines set quantity=$2, updated_at=now() where id=$1", [allocation.inventory_line_id, after]);
            await addLedger(client, {
                location: allocation.location,
                sku: component.sku,
                upc: allocation.upc,
                lotNumber: allocation.lot_number,
                expirationDate: allocation.expiration_date,
                delta: -SOURCE_CASES,
                before,
                after,
                userId: admin.id,
                idempotencyKey: `${REQUEST_CODE}:SOURCE:${component.sku}:3`
            });
            await client.query(
                `insert into item_catalog (
                    account_name, sku, upc, description, tracking_level, uom_label, unit_uom,
                    units_per_case, item_type, item_category, blocked
                 ) values ($1,$2,'',$3,'UNIT','EA','EA',1,'INVENTORY','KITTING WIP',true)
                 on conflict (account_name, sku) do update set description=excluded.description,
                    tracking_level='UNIT', uom_label='EA', unit_uom='EA', units_per_case=1,
                    item_category='KITTING WIP', blocked=true, updated_at=now()`,
                [ACCOUNT, component.wipSku, component.description]
            );
            const wip = await addInventory(client, {
                sku: component.wipSku,
                location: WIP_LOCATION,
                quantity: LOOSE_CANS_PER_FLAVOUR,
                trackingLevel: "UNIT",
                lotNumber: allocation.lot_number || "",
                expirationDate: allocation.expiration_date || "",
                userId: admin.id,
                key: `${REQUEST_CODE}:WIP:${component.wipSku}:9`
            });
            actualComponents.push({ sku: component.sku, totalQuantity: SOURCE_CASES, quantityPerUnit: null, description: component.description.replace(/^Kitting WIP - /, "") });
            sourceChanges.push({ sku: component.sku, location: allocation.location, before, deducted: SOURCE_CASES, after });
            wipChanges.push({ sku: component.wipSku, location: WIP_LOCATION, before: wip.before, added: LOOSE_CANS_PER_FLAVOUR, after: wip.after, pickable: false });
        }

        const boxBefore = Number(boxAllocation.on_hand_quantity);
        const boxAfter = boxBefore - BOX_QUANTITY;
        await client.query("update inventory_lines set quantity=$2, updated_at=now() where id=$1", [boxAllocation.inventory_line_id, boxAfter]);
        await addLedger(client, {
            location: boxAllocation.location,
            sku: BOX_SKU,
            upc: boxAllocation.upc,
            lotNumber: boxAllocation.lot_number,
            expirationDate: boxAllocation.expiration_date,
            delta: -BOX_QUANTITY,
            before: boxBefore,
            after: boxAfter,
            userId: admin.id,
            idempotencyKey: `${REQUEST_CODE}:SOURCE:${BOX_SKU}:63`
        });
        actualComponents.push({ sku: BOX_SKU, totalQuantity: BOX_QUANTITY, quantityPerUnit: null, description: "Empty box 4 pack MIXED" });

        const target = await addInventory(client, {
            sku: TARGET_SKU,
            location: TARGET_LOCATION,
            quantity: TARGET_QUANTITY,
            trackingLevel: "CASE",
            upc: TARGET_SKU,
            userId: admin.id,
            key: `${REQUEST_CODE}:FINISHED:${TARGET_SKU}:63`
        });

        await client.query("delete from portal_kitting_allocations where kitting_request_id=$1", [request.id]);
        const completionNote = "Physical completion posted: 63 variety packs. Consumed 3 cases of each flavour and 63 empty boxes. Nine loose cans per flavour were recorded in HEALTEA-KIT-WIP and are not pickable.";
        await client.query(
            `update portal_kitting_requests
             set source_quantity=$2, components_json=$3::jsonb, target_quantity=$4,
                 status='COMPLETED', warehouse_note=$5, completed_at=now(),
                 completed_by=$6, notes=concat_ws(' | ', nullif(notes,''), 'Original planned quantity 144; actual physical completion 63.'),
                 updated_at=now()
             where id=$1`,
            [request.id, SOURCE_CASES, JSON.stringify(actualComponents), TARGET_QUANTITY, completionNote, admin.full_name || admin.email]
        );
        await client.query(
            `insert into activity_log (type, title, details)
             values ('kitting',$1,$2)`,
            [`Updated kitting request ${REQUEST_CODE} to COMPLETED`, `${ACCOUNT} | Actual completion 63 of original planned 144 | Finished stock ${TARGET_LOCATION} pickable | Loose cans ${WIP_LOCATION} non-pickable | ${admin.full_name || admin.email}`]
        );
        await client.query("commit");

        result = {
            requestCode: REQUEST_CODE,
            status: "COMPLETED",
            originalPlannedQuantity: 144,
            actualCompletedQuantity: TARGET_QUANTITY,
            finished: { sku: TARGET_SKU, location: TARGET_LOCATION, before: target.before, added: TARGET_QUANTITY, after: target.after, pickable: true },
            boxes: { sku: BOX_SKU, location: boxAllocation.location, before: boxBefore, used: BOX_QUANTITY, after: boxAfter },
            sourceChanges,
            looseCanWip: wipChanges
        };
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    const email = await sendCompletionEmail(pool);
    const verification = await pool.query(
        `select k.status, k.target_quantity, k.completed_at, k.completed_by,
                i.quantity as finished_quantity, b.is_pickable, b.location_type,
                (select count(*)::int from portal_kitting_allocations a where a.kitting_request_id=k.id) as remaining_allocations,
                (select count(*)::int from inventory_transactions t where t.account_name=k.account_name and t.source_type='PORTAL_KITTING_REQUEST' and t.source_id=k.request_code) as ledger_entries
         from portal_kitting_requests k
         join inventory_lines i on i.account_name=k.account_name and i.sku=k.target_sku and i.location=$2
         join bin_locations b on b.code=i.location
         where k.request_code=$1`,
        [REQUEST_CODE, TARGET_LOCATION]
    );
    await pool.end();
    const verified = verification.rows[0];
    if (verified?.status !== "COMPLETED" || Number(verified.target_quantity) !== TARGET_QUANTITY
        || verified.is_pickable !== true || Number(verified.remaining_allocations) !== 0 || Number(verified.ledger_entries) !== 10) {
        throw new Error("Post-completion verification did not reconcile. Review the live transaction immediately.");
    }
    console.log(JSON.stringify({ ...result, verification: verified, email }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
