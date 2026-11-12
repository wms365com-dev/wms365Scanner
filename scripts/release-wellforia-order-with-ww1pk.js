const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const ORDER_CODE = "S-ORD101158";
const ACCOUNT = "WELLFORIA HEALTH INC";
const REQUIRED_SKU = "WW-1PK-UPC";
const REQUIRED_QUANTITY = 2;
const APPLY = process.argv.includes("--apply");
const ADD_ONLY = process.argv.includes("--add-only");
const STANDARD_EXEMPT = process.argv.includes("--standard-exempt");

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function dateOnly(value) {
    if (!value) return "";
    if (typeof value === "string") return value.slice(0, 10);
    return new Date(value).toISOString().slice(0, 10);
}

async function loadState(pool) {
    const orderResult = await pool.query(
        `select o.*, p.email as portal_user_email, p.is_active as portal_user_active
         from portal_orders o left join portal_vendor_access p on p.id=o.portal_access_id
         where o.account_name=$1 and upper(o.order_code)=upper($2) limit 1`,
        [ACCOUNT, ORDER_CODE]
    );
    if (orderResult.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found for Wellforia.`);
    const order = orderResult.rows[0];
    const [lines, inventory] = await Promise.all([
        pool.query(
            `select l.id, l.line_number, l.sku, l.requested_quantity, c.description, c.tracking_level
             from portal_order_lines l left join item_catalog c on c.account_name=$1 and c.sku=l.sku
             where l.order_id=$2 order by l.line_number,l.id`,
            [ACCOUNT, order.id]
        ),
        pool.query(
            `select i.id, i.location, i.quantity, i.tracking_level, b.is_pickable, b.location_type,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                              join portal_orders o on o.id=a.order_id
                              where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED') and o.id<>$3),0)::int
                    + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                                join portal_kitting_requests k on k.id=a.kitting_request_id
                                where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed_quantity
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.quantity>0 order by i.id`,
            [ACCOUNT, REQUIRED_SKU, order.id]
        )
    ]);
    return { order, lines: lines.rows, inventory: inventory.rows };
}

function buildPayload(state) {
    const order = state.order;
    const targetLines = state.lines.filter((line) => line.sku === REQUIRED_SKU);
    if (targetLines.length > 1) throw new Error(`${ORDER_CODE} has duplicate ${REQUIRED_SKU} lines. No automated change was made.`);
    const lines = state.lines
        .filter((line) => line.sku !== REQUIRED_SKU)
        .map((line) => ({ sku: line.sku, quantity: Number(line.requested_quantity) }));
    lines.push({ sku: REQUIRED_SKU, quantity: REQUIRED_QUANTITY });
    return {
        accountName: order.account_name,
        poNumber: order.po_number,
        shippingReference: order.shipping_reference,
        contactName: order.contact_name,
        contactPhone: order.contact_phone,
        requestedShipDate: dateOnly(order.requested_ship_date),
        orderType: order.order_type,
        shipmentMethod: order.shipment_method,
        rushApproved: order.rush_approved === true,
        rushApprovedBy: order.rush_approved_by || "",
        rushExempt: order.rush_exempt === true || STANDARD_EXEMPT,
        rushExemptNote: STANDARD_EXEMPT
            ? "Standard processing approved by Prathab for this reopened order; no rush charge."
            : order.rush_exempt_note || "",
        orderNotes: order.order_notes,
        shipToName: order.ship_to_name,
        shipToPhone: order.ship_to_phone,
        shipToAddress1: order.ship_to_address1,
        shipToAddress2: order.ship_to_address2,
        shipToCity: order.ship_to_city,
        shipToState: order.ship_to_state,
        shipToPostalCode: order.ship_to_postal_code,
        shipToCountry: order.ship_to_country,
        fulfillmentLocationId: Number(order.fulfillment_location_id),
        routingEmail: order.routing_email || "",
        routingTotalWeight: order.routing_total_weight,
        routingWeightUom: order.routing_weight_uom || "LB",
        routingRequestedDeliveryDate: dateOnly(order.routing_requested_delivery_date),
        lines
    };
}

async function createTemporaryPortalSession(pool, accessId) {
    const token = crypto.randomBytes(32).toString("hex");
    const result = await pool.query(
        `insert into portal_sessions (portal_access_id, token_hash, expires_at)
         values ($1,$2,now() + interval '10 minutes') returning id`,
        [accessId, hashToken(token)]
    );
    return { id: result.rows[0].id, token };
}

async function callPortal(path, token, options = {}) {
    const response = await fetch(`${API_ORIGIN}${path}`, {
        ...options,
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Cookie: `wms365_portal_session=${encodeURIComponent(token)}`,
            ...(options.headers || {})
        },
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(`WMS365 request failed (${response.status}): ${payload.error || payload.message || "request failed"}`);
    }
    return payload;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let session = null;
    try {
        const before = await loadState(pool);
        if (before.order.status !== "DRAFT") {
            if (before.order.status === "RELEASED") {
                const required = before.lines.filter((line) => line.sku === REQUIRED_SKU);
                const allocations = await pool.query(
                    `select coalesce(sum(a.allocated_quantity),0)::int as quantity
                     from portal_order_allocations a join portal_order_lines l on l.id=a.order_line_id
                     where a.order_id=$1 and l.sku=$2`,
                    [before.order.id, REQUIRED_SKU]
                );
                const lineReconciliation = await pool.query(
                    `select l.line_number, l.sku, l.requested_quantity,
                            coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity,
                            array_agg(distinct a.location order by a.location) filter (where a.location<>'') as locations
                     from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
                     where l.order_id=$1 group by l.id order by l.line_number,l.id`,
                    [before.order.id]
                );
                if (required.length === 1 && Number(required[0].requested_quantity) === REQUIRED_QUANTITY
                    && Number(allocations.rows[0].quantity) === REQUIRED_QUANTITY) {
                    const unreconciled = lineReconciliation.rows.filter((line) => Number(line.requested_quantity) !== Number(line.allocated_quantity));
                    if (unreconciled.length) throw new Error(`${ORDER_CODE} has unreconciled released lines.`);
                    console.log(JSON.stringify({
                        mode: APPLY ? "APPLIED" : "PREVIEW",
                        alreadyReleased: true,
                        order: before.order,
                        requiredLine: required[0],
                        allocatedQuantity: REQUIRED_QUANTITY,
                        lineReconciliation: lineReconciliation.rows
                    }, null, 2));
                    return;
                }
            }
            throw new Error(`${ORDER_CODE} is ${before.order.status}, not an editable draft.`);
        }
        if (!before.order.portal_access_id || !before.order.portal_user_email || before.order.portal_user_active !== true) {
            throw new Error("The order's original Wellforia portal user is missing or inactive.");
        }
        const available = before.inventory.reduce((sum, row) => (
            row.is_pickable === true && !["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE", "RECEIVING_STAGE"].includes(String(row.location_type || "").toUpperCase())
                ? sum + Math.max(Number(row.quantity) - Number(row.committed_quantity), 0)
                : sum
        ), 0);
        if (available < REQUIRED_QUANTITY) throw new Error(`Only ${available} pickable cases of ${REQUIRED_SKU} are available.`);
        const currentRequired = before.lines.filter((line) => line.sku === REQUIRED_SKU);
        const needsLineUpdate = currentRequired.length !== 1 || Number(currentRequired[0].requested_quantity) !== REQUIRED_QUANTITY;
        const payload = buildPayload(before);
        if (!APPLY) {
            console.log(JSON.stringify({
                mode: "PREVIEW",
                order: {
                    code: before.order.order_code,
                    status: before.order.status,
                    account: before.order.account_name,
                    portalUser: before.order.portal_user_email,
                    requestedShipDate: dateOnly(before.order.requested_ship_date)
                },
                currentLines: before.lines.map((line) => ({ line: line.line_number, sku: line.sku, quantity: Number(line.requested_quantity), description: line.description })),
                requiredLine: { sku: REQUIRED_SKU, requiredQuantity: REQUIRED_QUANTITY, currentQuantity: currentRequired.reduce((sum, line) => sum + Number(line.requested_quantity), 0), needsUpdate: needsLineUpdate },
                pickableAvailableCases: available,
                releaseWillNotifyWarehouse: true
            }, null, 2));
            return;
        }

        if (ADD_ONLY) {
            const client = await pool.connect();
            try {
                await client.query("begin");
                const locked = await client.query(
                    "select id, status from portal_orders where id=$1 and account_name=$2 for update",
                    [before.order.id, ACCOUNT]
                );
                if (locked.rows[0]?.status !== "DRAFT") throw new Error(`${ORDER_CODE} is no longer an editable draft.`);
                const existing = await client.query(
                    "select id, requested_quantity from portal_order_lines where order_id=$1 and sku=$2 order by id for update",
                    [before.order.id, REQUIRED_SKU]
                );
                if (existing.rowCount > 1) throw new Error(`${ORDER_CODE} has duplicate ${REQUIRED_SKU} lines.`);
                if (existing.rowCount === 1) {
                    await client.query(
                        "update portal_order_lines set requested_quantity=$2, updated_at=now() where id=$1",
                        [existing.rows[0].id, REQUIRED_QUANTITY]
                    );
                } else {
                    await client.query(
                        `insert into portal_order_lines (order_id,line_number,sku,requested_quantity)
                         select $1,coalesce(max(line_number),0)+1,$2,$3 from portal_order_lines where order_id=$1`,
                        [before.order.id, REQUIRED_SKU, REQUIRED_QUANTITY]
                    );
                }
                await client.query("update portal_orders set updated_at=now() where id=$1", [before.order.id]);
                await client.query(
                    `insert into activity_log (type,title,details) values ('order',$1,$2)`,
                    [`Added required line to portal order ${ORDER_CODE}`, `${ACCOUNT} | ${REQUIRED_QUANTITY} cases ${REQUIRED_SKU} | Draft retained pending rush approval | ${before.order.portal_user_email}`]
                );
                await client.query("commit");
            } catch (error) {
                await client.query("rollback").catch(() => {});
                throw error;
            } finally {
                client.release();
            }
            const afterAdd = await loadState(pool);
            const requiredAfterAdd = afterAdd.lines.filter((line) => line.sku === REQUIRED_SKU);
            if (afterAdd.order.status !== "DRAFT" || requiredAfterAdd.length !== 1 || Number(requiredAfterAdd[0].requested_quantity) !== REQUIRED_QUANTITY) {
                throw new Error("The required line did not verify after the draft update.");
            }
            console.log(JSON.stringify({
                mode: "APPLIED",
                addedOnly: true,
                order: { code: afterAdd.order.order_code, status: afterAdd.order.status },
                requiredLine: { sku: REQUIRED_SKU, quantity: Number(requiredAfterAdd[0].requested_quantity) },
                releaseBlockedPendingRushApproval: true
            }, null, 2));
            return;
        }

        session = await createTemporaryPortalSession(pool, before.order.portal_access_id);
        let savedOrder = null;
        if (needsLineUpdate) {
            const saved = await callPortal(`/api/portal/orders/${before.order.id}`, session.token, {
                method: "PUT",
                body: JSON.stringify(payload)
            });
            savedOrder = saved.order;
        }
        const released = await callPortal(`/api/portal/orders/${before.order.id}/release`, session.token, {
            method: "POST",
            body: JSON.stringify({
                notifyWarehouse: true,
                shippingLabelAttached: false,
                ccEmails: [],
                rushApproved: false,
                rushExempt: STANDARD_EXEMPT,
                rushExemptNote: STANDARD_EXEMPT
                    ? "Standard processing approved by Prathab for this reopened order; no rush charge."
                    : "",
                splitFulfillmentApproved: false
            })
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const after = await loadState(pool);
        const finalRequired = after.lines.filter((line) => line.sku === REQUIRED_SKU);
        const allocation = await pool.query(
            `select coalesce(sum(a.allocated_quantity),0)::int as quantity,
                    array_agg(distinct a.location order by a.location) filter (where a.location<>'') as locations
             from portal_order_allocations a join portal_order_lines l on l.id=a.order_line_id
             where a.order_id=$1 and l.sku=$2`,
            [after.order.id, REQUIRED_SKU]
        );
        if (after.order.status !== "RELEASED" || finalRequired.length !== 1
            || Number(finalRequired[0].requested_quantity) !== REQUIRED_QUANTITY
            || Number(allocation.rows[0].quantity) !== REQUIRED_QUANTITY) {
            throw new Error("The released order did not reconcile with the required two-case line. Review it immediately.");
        }
        console.log(JSON.stringify({
            mode: "APPLIED",
            lineUpdated: needsLineUpdate,
            savedOrder: savedOrder ? { status: savedOrder.status, lineCount: savedOrder.lines?.length } : null,
            order: { code: after.order.order_code, status: after.order.status, account: after.order.account_name, releasedAt: after.order.released_at },
            requiredLine: { sku: REQUIRED_SKU, quantity: Number(finalRequired[0].requested_quantity), allocatedQuantity: Number(allocation.rows[0].quantity), locations: allocation.rows[0].locations || [] },
            releaseActions: released.releaseActions || null
        }, null, 2));
    } finally {
        if (session?.id) await pool.query("delete from portal_sessions where id=$1", [session.id]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
