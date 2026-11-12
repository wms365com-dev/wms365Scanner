const { Client } = require("pg");
const {
    APP_USER_ROLES,
    getPortalInventorySummary,
    recordInventoryTransaction,
    upsertInventoryLine
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "PURE FOODS BY ESTEE";
const ACCOUNT_ID = "1";
const SKU = "CHD-CU-6049701-019";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const LOCATION = "GW3PL-MISS-CJ08AA";
const QUANTITY = 3;
const SOURCE_ID = "PURE-FOODS-CHD-CU-6049701-019-PLUS3-20261027";
const IDEMPOTENCY_KEY = `${SOURCE_ID}:${LOCATION}`;
const CORRECTION_ID = `${SOURCE_ID}-CORRECT-OVERADJUSTMENT`;
const CORRECTION_KEY = `${CORRECTION_ID}:${LOCATION}`;
const DELIVERY_KEY = "PURE-FOODS-INVENTORY-AVAILABLE-CHD-CU-6049701-019-PLUS3-20261027";
const NOTIFICATION_TYPE = "INVENTORY_AVAILABLE";
const SYSTEM_TO = "support@wms365.co";
const ACTOR = {
    id: null,
    email: "operations@wms365.co",
    full_name: "WMS365 Owner-Approved Inventory Adjustment",
    role: APP_USER_ROLES.SUPER_ADMIN
};

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

async function getFacts(db, lock = false) {
    const account = await db.query(
        `select id,name,is_active from owner_accounts where name=$1`,
        [ACCOUNT]
    );
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
        throw new Error("Pure Foods account identity mismatch.");
    }
    const warehouse = await db.query(
        `select fl.id,fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
         from fulfillment_locations fl
         join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
         where fl.id=$2 and fl.code=$3`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || !wh.is_active || !wh.allow_outbound
        || !wh.allow_storage || !wh.customer_portal_visible) {
        throw new Error("Pure Foods Mississauga warehouse assignment mismatch.");
    }
    const item = await db.query(
        `select sku,description,upc,tracking_level,uom_label,unit_uom,units_per_case,item_type,blocked
         from item_catalog where account_name=$1 and sku=$2 ${lock ? "for update" : ""}`,
        [ACCOUNT, SKU]
    );
    const catalog = item.rows[0];
    if (item.rowCount !== 1 || catalog.blocked || catalog.item_type !== "INVENTORY"
        || catalog.tracking_level !== "CASE" || catalog.unit_uom !== "CASE"
        || Number(catalog.units_per_case) !== 1) {
        throw new Error("Pure Foods item identity or case configuration mismatch.");
    }
    const bin = await db.query(
        `select code,account_name,fulfillment_location_id,location_type,is_pickable
         from bin_locations where code=$1 ${lock ? "for update" : ""}`,
        [LOCATION]
    );
    const location = bin.rows[0];
    if (bin.rowCount !== 1 || location.account_name !== ACCOUNT
        || Number(location.fulfillment_location_id) !== WAREHOUSE_ID
        || location.location_type !== "STORAGE" || !location.is_pickable) {
        throw new Error("The selected Pure Foods Mississauga bin is not pickable or correctly scoped.");
    }
    const inventory = await db.query(
        `select * from inventory_lines
         where account_name=$1 and location=$2 and sku=$3 and lot_number='' and expiration_date=''
         ${lock ? "for update" : ""}`,
        [ACCOUNT, LOCATION, SKU]
    );
    if (inventory.rowCount !== 1) throw new Error("Expected one existing inventory line in the selected bin.");
    const prior = await db.query(
        `select id,quantity_delta,quantity_before,quantity_after
         from inventory_transactions where idempotency_key=$1`,
        [IDEMPOTENCY_KEY]
    );
    const correction = await db.query(
        `select id,quantity_delta,quantity_before,quantity_after
         from inventory_transactions where idempotency_key=$1`,
        [CORRECTION_KEY]
    );
    const physical = await db.query(
        `select coalesce(sum(i.quantity),0)::numeric total
         from inventory_lines i
         join bin_locations b on b.code=i.location
         where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=$3`,
        [ACCOUNT, SKU, WAREHOUSE_ID]
    );
    const reserved = await db.query(
        `select coalesce(sum(a.allocated_quantity),0)::numeric total
         from portal_order_allocations a
         join portal_orders o on o.id=a.order_id
         where o.account_name=$1 and o.fulfillment_location_id=$2 and a.sku=$3
           and o.status in ('RELEASED','PICKING','PICKED','STAGED')`,
        [ACCOUNT, WAREHOUSE_ID, SKU]
    );
    const portal = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: WAREHOUSE_ID });
    const portalItem = portal.find((entry) => entry.sku === SKU) || null;
    return {
        catalog,
        location,
        inventory: inventory.rows[0],
        prior: prior.rows[0] || null,
        correction: correction.rows[0] || null,
        portalItem,
        physicalOnHand: Number(physical.rows[0].total),
        reservedQuantity: Number(reserved.rows[0].total)
    };
}

async function sendNotice(db, expectedAvailable) {
    const existing = await db.query(
        `select id,status,message_id,to_addresses,cc_addresses,bcc_addresses
         from email_delivery_log where delivery_key=$1`,
        [DELIVERY_KEY]
    );
    if (existing.rows[0]?.status === "SENT") {
        return { sent: true, duplicatePrevented: true, recipientCount: existing.rows[0].bcc_addresses.length };
    }
    if (!process.env.RESEND_API_KEY) throw new Error("Production email provider is unavailable; inventory was adjusted but notice was not sent.");
    const [contacts, preferences] = await Promise.all([
        db.query(
            `select email from portal_vendor_access
             where account_name=$1 and is_active=true and btrim(coalesce(email,''))<>'' order by id`,
            [ACCOUNT]
        ),
        db.query(
            `select lower(email) email,is_subscribed from customer_email_preferences
             where account_name=$1 and notification_type in ($2,'*')`,
            [ACCOUNT, NOTIFICATION_TYPE]
        )
    ]);
    const optedOut = new Set(preferences.rows
        .filter((row) => row.is_subscribed === false)
        .map((row) => normalizeEmail(row.email)));
    const recipients = [...new Set(contacts.rows.map((row) => normalizeEmail(row.email)).filter(Boolean))]
        .filter((email) => !optedOut.has(email) && !optedOut.has("*"));
    if (!recipients.length) throw new Error("No subscribed Pure Foods portal contacts are available for the inventory notice.");

    const subject = `Inventory Available - ${SKU} - Pure Foods`;
    const text = [
        "Hello Pure Foods team,", "",
        `${QUANTITY} cases of item ${SKU} have been added and are now available for ordering from the Mississauga warehouse.`,
        "",
        `Available quantity: ${expectedAvailable} cases`,
        "",
        "Regards,", "WMS365 Support"
    ].join("\n");
    const html = `<div style="font-family:Arial,sans-serif;color:#172b3a;line-height:1.55;max-width:680px">
<p>Hello Pure Foods team,</p>
<p><strong>${QUANTITY} cases</strong> of item <strong>${SKU}</strong> have been added and are now available for ordering from the <strong>Mississauga warehouse</strong>.</p>
<p>Available quantity: <strong>${expectedAvailable} cases</strong></p>
<p>Regards,<br>WMS365 Support</p></div>`;

    const log = await db.query(
        `insert into email_delivery_log (
            status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,subject,
            account_name,source_type,source_ref,delivery_key,metadata
         ) values ('PENDING','RESEND','WMS365 <support@wms365.co>',$1::jsonb,'[]'::jsonb,$2::jsonb,
                   $3,$4,$5,$6,$7,$8,$9::jsonb)
         on conflict(delivery_key) do update set status='PENDING',error_message='',failed_at=null,
             to_addresses=excluded.to_addresses,cc_addresses='[]'::jsonb,
             bcc_addresses=excluded.bcc_addresses,updated_at=now()
         returning id`,
        [JSON.stringify([SYSTEM_TO]), JSON.stringify(recipients), SYSTEM_TO, subject,
            ACCOUNT, NOTIFICATION_TYPE, SKU, DELIVERY_KEY,
            JSON.stringify({ warehouseCode: WAREHOUSE_CODE, quantityAdded: QUANTITY,
                availableQuantity: expectedAvailable, addressing: "BCC_ONLY" })]
    );
    const logId = log.rows[0].id;
    try {
        const response = await fetch(`${(process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": DELIVERY_KEY
            },
            body: JSON.stringify({
                from: "WMS365 <support@wms365.co>", to: [SYSTEM_TO], cc: [], bcc: recipients,
                reply_to: SYSTEM_TO, subject, text, html
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) throw new Error(payload.message || payload.error || `Resend failed (${response.status}).`);
        await db.query(
            `update email_delivery_log set status='SENT',message_id=$2,provider_response=$3,
                    sent_at=now(),updated_at=now() where id=$1`,
            [logId, payload.id, "Resend accepted the BCC-only inventory availability notice."]
        );
        return { sent: true, providerAccepted: true, recipientCount: recipients.length };
    } catch (error) {
        await db.query(
            `update email_delivery_log set status='FAILED',error_message=$2,failed_at=now(),updated_at=now() where id=$1`,
            [logId, String(error.message || error).slice(0, 2000)]
        ).catch(() => {});
        throw error;
    }
}

async function main() {
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await db.connect();
    try {
        await db.query("begin");
        await db.query("set transaction read only");
        const before = await getFacts(db);
        await db.query("rollback");
        console.log(JSON.stringify({
            phase: "preflight", account: ACCOUNT, sku: SKU, warehouse: WAREHOUSE_CODE,
            location: LOCATION, currentBinQuantity: Number(before.inventory.quantity),
            onHand: before.physicalOnHand,
            reserved: before.reservedQuantity,
            available: before.physicalOnHand - before.reservedQuantity,
            priorAdjustment: Boolean(before.prior),
            correctiveAdjustment: Boolean(before.correction)
        }));
        if (!APPLY) return;

        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [SOURCE_ID]);
        const current = await getFacts(db, true);
        let expectedOnHand = current.physicalOnHand;
        let expectedAvailable = current.physicalOnHand - current.reservedQuantity;
        if (!current.prior) {
            const result = await upsertInventoryLine(db, {
                accountName: ACCOUNT,
                location: LOCATION,
                sku: SKU,
                upc: current.catalog.upc || "",
                lotNumber: "",
                expirationDate: "",
                trackingLevel: "CASE",
                quantity: QUANTITY
            }, {
                transactionType: "ADJUSTMENT",
                sourceType: "OWNER_APPROVED_ADJUSTMENT",
                sourceId: SOURCE_ID,
                fulfillmentLocationId: WAREHOUSE_ID,
                appUser: ACTOR,
                idempotencyKey: IDEMPOTENCY_KEY,
                source: "web_admin",
                notes: "Owner-approved positive adjustment of 3 Pure Foods cases at Mississauga."
            });
            if (!result) throw new Error("Inventory adjustment did not return a result.");
            expectedOnHand += QUANTITY;
            expectedAvailable += QUANTITY;
            await db.query(
                `insert into activity_log(type,title,details) values('inventory',$1,$2)`,
                [`Added 3 cases of ${SKU} for Pure Foods`,
                    `${ACCOUNT} | ${WAREHOUSE_CODE} | ${LOCATION} | +${QUANTITY} cases | Owner approved`]
            );
        } else {
            const originalDelta = Number(current.prior.quantity_delta);
            if (originalDelta === 43 && !current.correction) {
                const correctionDelta = QUANTITY - originalDelta;
                const quantityBefore = Number(current.inventory.quantity);
                const quantityAfter = quantityBefore + correctionDelta;
                if (quantityAfter < 0) throw new Error("Corrective adjustment would make inventory negative.");
                const corrected = await db.query(
                    `update inventory_lines set quantity=$2,updated_at=now()
                     where id=$1 and quantity=$3 returning *`,
                    [current.inventory.id, quantityAfter, quantityBefore]
                );
                if (corrected.rowCount !== 1) throw new Error("Inventory changed before the correction could be applied.");
                const recorded = await recordInventoryTransaction(db, {
                    line: corrected.rows[0],
                    quantityBefore,
                    quantityAfter,
                    quantityDelta: correctionDelta,
                    transactionType: "ADJUSTMENT",
                    sourceType: "OWNER_APPROVED_ADJUSTMENT_CORRECTION",
                    sourceId: CORRECTION_ID,
                    fulfillmentLocationId: WAREHOUSE_ID,
                    appUser: ACTOR,
                    idempotencyKey: CORRECTION_KEY,
                    source: "web_admin",
                    notes: "Corrects an over-adjustment so the owner-approved net increase is exactly 3 cases."
                });
                if (!recorded) throw new Error("Corrective inventory ledger entry was not recorded.");
                expectedOnHand += correctionDelta;
                expectedAvailable += correctionDelta;
                await db.query(
                    `insert into activity_log(type,title,details) values('inventory',$1,$2)`,
                    [`Corrected Pure Foods ${SKU} adjustment to net +3 cases`,
                        `${ACCOUNT} | ${WAREHOUSE_CODE} | ${LOCATION} | -40 case correction | Net owner-approved adjustment +3 cases`]
                );
            } else if (originalDelta === 43 && current.correction) {
                if (Number(current.correction.quantity_delta) !== -40) {
                    throw new Error("Existing corrective adjustment conflicts with the required net quantity.");
                }
            } else if (originalDelta !== QUANTITY) {
                throw new Error("Existing adjustment idempotency record conflicts with the requested quantity.");
            }
        }
        await db.query("commit");

        await db.query("begin read only");
        const verified = await getFacts(db);
        await db.query("rollback");
        const onHand = verified.physicalOnHand;
        const available = verified.physicalOnHand - verified.reservedQuantity;
        const netAdjustment = Number(verified.prior?.quantity_delta || 0)
            + Number(verified.correction?.quantity_delta || 0);
        if (!verified.prior || netAdjustment !== QUANTITY
            || onHand !== expectedOnHand || available !== expectedAvailable
            || available < QUANTITY || !verified.location.is_pickable) {
            throw new Error("Post-adjustment customer availability verification failed.");
        }
        if (!verified.portalItem || Number(verified.portalItem.onHandQuantity) !== onHand
            || Number(verified.portalItem.reservedQuantity) !== verified.reservedQuantity
            || Number(verified.portalItem.availableQuantity) !== available) {
            throw new Error("Customer portal inventory summary did not expose the adjusted stock correctly.");
        }

        const email = await sendNotice(db, available);
        const sent = await db.query(
            `select status,message_id,to_addresses,cc_addresses,bcc_addresses
             from email_delivery_log where delivery_key=$1`,
            [DELIVERY_KEY]
        );
        const envelope = sent.rows[0];
        if (!envelope || envelope.status !== "SENT" || !envelope.message_id
            || envelope.to_addresses.length !== 1 || envelope.to_addresses[0] !== SYSTEM_TO
            || envelope.cc_addresses.length !== 0 || envelope.bcc_addresses.length < 1) {
            throw new Error("BCC-only customer email verification failed.");
        }
        console.log(JSON.stringify({
            phase: "verified", account: ACCOUNT, sku: SKU, warehouse: WAREHOUSE_CODE,
            quantityAdded: QUANTITY, onHand, available, pickable: verified.location.is_pickable,
            emailStatus: envelope.status, visibleToCount: envelope.to_addresses.length,
            ccCount: envelope.cc_addresses.length, bccCount: envelope.bcc_addresses.length,
            messageIdPresent: Boolean(envelope.message_id), email
        }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
