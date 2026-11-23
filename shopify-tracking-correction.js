"use strict";

/**
 * Parent handoff: correction(connectedClient, authorizedRawTracker, input,
 * { request, decrypt, actor, assertFeatures, trackingRuntimeAvailable? }).
 * trackingRuntimeAvailable defaults OFF; parent may pass true only after its
 * AfterShip credential/runtime activation gate passes. Never enable by enrollment
 * alone. This helper OWNS two transactions;
 * never call inside withTransaction or on a shared pool/client. Parent must assert
 * admin company/warehouse access before passing the tracker; assertFeatures is a
 * mandatory injected company/store feature gate (assertFeature alias supported).
 * request follows shopify-tracking-sync's integration/path/options contract, must
 * be timeout-bounded, pinned to that store, and MUST NOT retry mutations. No default
 * DB/network/decryption implementation exists. No automatic integration is added.
 *
 * Phase one commits an immutable MANUAL_CLOSE audit intent and pauses the old
 * identity BEFORE the remote write. Phase two reacquires all locks, reconciles,
 * writes at most once, then reconciles again. Uncertain/crashed sends can ONLY be
 * read-reconciled on subsequent calls: never replayed, even if remote still shows
 * the old number. Return NEEDS_MANUAL_RECONCILE to the admin, not a retry job.
 * Audit reason contains versioned JSON including the administrator's explicit
 * reason, old/new identities and phase; no schema/enum migration is needed.
 *
 * Existing schema cannot replace a carrier while retaining the same tracking
 * number with a NEW tracker ID (unique shipment/number). Reject that, multiple
 * packages/bindings/shipments, in-flight carrier claims, or incomplete evidence.
 * No tracking events are copied/deleted; historical audit/SENT outbox stays intact.
 * Status-event outbox is discarded by old source tracker, never blanket deleted.
 * Pending/uncertain delivery notifications also require separate manual review.
 * Parent rollout must cover transaction ownership, crash/commit-failure recovery,
 * admin response mapping and test-company/development-store verification.
 *
 * Shopify primary docs reviewed 2026-09-17 (2026-07 latest):
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentTrackingInfoUpdate
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentTrackingInfo
 * Requires write_assigned_fulfillment_orders OR write_merchant_managed_fulfillment_orders
 * OR write_third_party_fulfillment_orders, and fulfill_and_ship_orders permission.
 * Reconciliation needs Fulfillment read access. notifyCustomer is always false;
 * mutation acceptance is not delivery or customer-notification evidence.
 */
const { randomUUID } = require("node:crypto");
const { normalizeTrackingCarrier, normalizeTrackingStatus, afterShipCarrierSlug } = require("./carrier-tracking");
const { bindingForTracker } = require("./shopify-tracking-sync");

const COMPANIES = Object.freeze({ CANPAR: "Canpar", ICS_COURIER: "ICS Courier", GLS: "GLS" });
const SQL = Object.freeze({
    transactionState: `select (xact_start < query_start) as already_in_transaction
        from pg_stat_activity where pid=pg_backend_pid()`,
    tracker: `select * from shipment_trackers where id=$1 and account_name=$2 and order_id=$3
        and fulfillment_location_id=$4 and warehouse_shipment_id=$5 for update`,
    advisory: "select pg_try_advisory_xact_lock(hashtext('shopify-tracking'), $1::integer) as locked",
    binding: `select * from shopify_tracking_fulfillments where id=$1 and account_name=$2 and order_id=$3
        and integration_id=$4 and store_identifier=$5 for update`,
    store: `select * from store_integrations where id=$1 and account_name=$2 and store_identifier=$3
        and provider='SHOPIFY' for update`,
    packages: "select * from shopify_tracking_packages where fulfillment_binding_id=$1 for update",
    trackerPackages: "select * from shopify_tracking_packages where tracker_id=$1 for update",
    shipment: `select * from warehouse_shipments where id=$1 and account_name=$2 and order_id=$3
        and fulfillment_location_id=$4 for update`,
    order: "select * from portal_orders where id=$1 and account_name=$2 for update",
    shipmentCount: "select id from warehouse_shipments where order_id=$1 and account_name=$2 order by id for update",
    imported: `select imp.id from store_order_imports imp join portal_orders o on o.id=imp.portal_order_id
        where imp.integration_id=$1 and imp.portal_order_id=$2 and imp.external_order_id=$3 and o.account_name=$4 for share of imp`,
    evidence: `select id from shipment_tracking_events where tracker_id=$1 and status='DELIVERED'
        union all select id from shopify_tracking_outbox where fulfillment_binding_id=$2 and status='DELIVERED' and state='SENT'`,
    notifications: `select id from shopify_delivery_notification_outbox where integration_id=$1 and account_name=$2
        and order_id=$3 and shipment_id=$4 and status in ('PENDING','DEFERRED','SENDING','UNCERTAIN','FAILED') for update`,
    pendingOutbox: `select ob.id,ob.source_event_id,e.tracker_id from shopify_tracking_outbox ob
        left join shipment_tracking_events e on e.id=ob.source_event_id
        where ob.fulfillment_binding_id=$1 and ob.state<>'SENT' and ob.discarded_at is null for update of ob`,
    collision: `select id from shipment_trackers where account_name=$1 and order_id=$2 and tracking_number=$3 for update`,
    auditRead: `select * from shopify_tracking_corrections where tracker_id=$1 and fulfillment_binding_id=$2
        and action='MANUAL_CLOSE' order by id desc limit 100`,
    audit: `insert into shopify_tracking_corrections (fulfillment_binding_id,tracker_id,actor,reason,action)
        values ($1,$2,$3,$4,'MANUAL_CLOSE') returning id`,
    close: `update shipment_trackers set manual_closed_at=now(),is_active=false,next_poll_at=null,
        claimed_at=null,claimed_by='',updated_at=now() where id=$1 and account_name=$2 and order_id=$3
        and fulfillment_location_id=$4 and warehouse_shipment_id=$5 returning id`,
    discard: `update shopify_tracking_outbox ob set discarded_at=now(),state='BLOCKED',
        last_error='Tracking identity superseded by audited correction.'
        where ob.fulfillment_binding_id=$1 and ob.fulfillment_gid=$2 and ob.state<>'SENT' and ob.discarded_at is null
          and ob.source_event_id in (select e.id from shipment_tracking_events e where e.tracker_id=$3)`,
    newTracker: `insert into shipment_trackers (warehouse_shipment_id,order_id,account_name,fulfillment_location_id,
        provider_key,provider_tracker_id,carrier_key,carrier_name,carrier_slug,tracking_number,tracking_url,
        status,status_detail,is_active,next_poll_at)
        values ($1,$2,$3,$4,'AFTERSHIP','',$5,$6,$7,$8,$9,'PENDING','Audited tracking correction',$10,
            case when $10 then now() end) returning *`,
    rebind: `update shopify_tracking_packages set tracker_id=$2,package_id=$2::text,tracking_number=$3,
        confirmed_delivered_at=null,delivery_event_id=null where id=$1 and tracker_id=$4
        and fulfillment_binding_id=$5 and account_name=$6 and order_id=$7
        and fulfillment_location_id=$8 and warehouse_shipment_id=$9 returning id`,
    expected: `update shopify_tracking_fulfillments set expected_tracking_numbers=$2::jsonb,
        last_shopify_check_at=now(),updated_at=now() where id=$1 and account_name=$3 and order_id=$4
        and integration_id=$5 and store_identifier=$6 returning id`,
    updateShipment: `update warehouse_shipments set tracking_reference=$2,carrier_name=$3,updated_at=now()
        where id=$1 and account_name=$4 and order_id=$5 and fulfillment_location_id=$6 returning id`,
    updateOrder: `update portal_orders set shipped_tracking_reference=$2,shipped_carrier_name=$3,updated_at=now()
        where id=$1 and account_name=$4 returning id`
});
const REMOTE_FIELDS = `id status displayStatus deliveredAt order { id } trackingInfo { company number url }
    events(first:100) { nodes { status } pageInfo { hasNextPage } }`;
const READ = `query CorrectionTracking($id:ID!) { shop { id myshopifyDomain }
    fulfillment(id:$id) { ${REMOTE_FIELDS} } }`;
const UPDATE = `mutation CorrectTracking($id:ID!,$tracking:FulfillmentTrackingInput!) {
    fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$tracking,notifyCustomer:false) {
        fulfillment { id } userErrors { field message } } }`;

function error(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }
function reject(code, statusCode) { throw error(code, statusCode); }
function same(a, b) { return String(a) === String(b); }
function positive(value) { return /^(?:[1-9][0-9]*)$/.test(String(value)); }
function targetInfo(input, old) {
    if (!input || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 600) reject("explicit_reason_required", 400);
    const carrier = normalizeTrackingCarrier(input.carrier ?? old.carrier_key);
    if (!Object.hasOwn(COMPANIES, carrier)) reject("unsupported_carrier", 400);
    const number = input.trackingNumber ?? old.tracking_number;
    if (typeof number !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(number)) reject("invalid_tracking_number", 400);
    if (number === old.tracking_number) reject("same_number_rebinding_unsupported");
    const encoded = encodeURIComponent(number);
    const url = carrier === "CANPAR" ? `https://www.canpar.com/en/tracking/track.htm?barcode=${encoded}`
        : carrier === "ICS_COURIER" ? `https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=${encoded}`
            : `https://ship.gls-canada.com/tracking/${encoded}`;
    return { carrier, company: COMPANIES[carrier], number, url };
}
function outcome(status, trackerId, code, correctionId) {
    return { status, trackerId: String(trackerId), needsManualReconcile: status === "NEEDS_MANUAL_RECONCILE" ||
        ["remote_delivered_inconsistent", "notification_reconciliation_required", "closed_identity_requires_manual_reconcile"].includes(code),
        ...(code ? { code } : {}), ...(correctionId ? { correctionId } : {}) };
}
async function one(client, sql, params, code = "scope_changed") {
    const result = await client.query(sql, params);
    if (result.rows.length !== 1) reject(code);
    return result.rows[0];
}
async function transaction(client, fn) {
    await client.query("begin");
    try {
        await client.query("set local lock_timeout='3s'");
        const result = await fn();
        await client.query("commit");
        return result;
    } catch (cause) {
        await client.query("rollback").catch(() => {});
        throw cause;
    }
}
async function lockedScope(client, supplied, assertFeatures) {
    const scope = [supplied.id, supplied.account_name, supplied.order_id, supplied.fulfillment_location_id, supplied.warehouse_shipment_id];
    const tracker = await one(client, SQL.tracker, scope, "tracker_scope_changed");
    const matches = await bindingForTracker(client, tracker.id);
    if (matches.length !== 1) reject("complex_binding_unsupported");
    const match = matches[0];
    if (!(await one(client, SQL.advisory, [match.id])).locked) reject("correction_busy");
    const binding = await one(client, SQL.binding, [match.id, tracker.account_name, tracker.order_id, match.integration_id, match.store_identifier]);
    const store = await one(client, SQL.store, [binding.integration_id, tracker.account_name, binding.store_identifier]);
    if (store.is_active !== true || store.settings?.carrierFulfillmentEventsEnabled !== true ||
        !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.store_identifier)) reject("store_tracking_disabled");
    await assertFeatures(client, tracker.account_name, store);
    const packages = (await client.query(SQL.packages, [binding.id])).rows;
    const trackerPackages = (await client.query(SQL.trackerPackages, [tracker.id])).rows;
    if (packages.length !== 1 || trackerPackages.length !== 1) reject("complex_package_unsupported");
    const pkg = packages[0];
    if (!same(pkg.id, trackerPackages[0].id) || !same(pkg.tracker_id, tracker.id) ||
        !same(pkg.account_name, tracker.account_name) || !same(pkg.order_id, tracker.order_id) ||
        !same(pkg.fulfillment_location_id, tracker.fulfillment_location_id) || !same(pkg.warehouse_shipment_id, tracker.warehouse_shipment_id) ||
        pkg.tracking_number !== tracker.tracking_number || !Array.isArray(binding.expected_tracking_numbers) ||
        binding.expected_tracking_numbers.length !== 1 || binding.expected_tracking_numbers[0] !== tracker.tracking_number) reject("package_scope_changed");
    const shipment = await one(client, SQL.shipment, [tracker.warehouse_shipment_id, tracker.account_name, tracker.order_id, tracker.fulfillment_location_id]);
    const order = await one(client, SQL.order, [tracker.order_id, tracker.account_name]);
    const shipments = await client.query(SQL.shipmentCount, [tracker.order_id, tracker.account_name]);
    if (shipments.rows.length !== 1 || !same(shipments.rows[0].id, shipment.id) || shipment.status !== "SHIPPED" ||
        shipment.shipment_method !== "PARCEL" || shipment.package_count !== 1 ||
        shipment.tracking_reference !== tracker.tracking_number || order.shipped_tracking_reference !== tracker.tracking_number) reject("complex_shipment_unsupported");
    await one(client, SQL.imported, [store.id, tracker.order_id, binding.external_order_id, tracker.account_name], "import_ownership_unverified");
    if (normalizeTrackingStatus(tracker.status) === "DELIVERED" || tracker.delivered_at || pkg.confirmed_delivered_at || pkg.delivery_event_id ||
        (await client.query(SQL.evidence, [tracker.id, binding.id])).rows.length) reject("delivered_tracking_locked");
    if (tracker.claimed_at || tracker.claimed_by) reject("carrier_poll_in_flight");
    if ((await client.query(SQL.notifications, [store.id, tracker.account_name, String(tracker.order_id), String(shipment.id)])).rows.length) reject("notification_reconciliation_required");
    const pending = (await client.query(SQL.pendingOutbox, [binding.id])).rows;
    if (pending.some((event) => !event.source_event_id || !same(event.tracker_id, tracker.id))) reject("outbox_scope_unverified");
    return { tracker, binding, store, pkg, scope };
}
function bindingIdentity(state) {
    const binding = state.binding;
    return { bindingId: String(binding.id), integrationId: String(binding.integration_id), store: binding.store_identifier,
        fulfillmentGid: binding.fulfillment_gid, externalOrderId: String(binding.external_order_id), shopGid: binding.shopify_store_gid || "" };
}
function verifyIntent(state, record) {
    if (JSON.stringify(record.binding) !== JSON.stringify(bindingIdentity(state)) ||
        record.old.trackerId !== String(state.tracker.id) || record.old.packageId !== state.pkg.package_id ||
        record.old.carrier !== state.tracker.carrier_key || record.old.number !== state.tracker.tracking_number ||
        record.old.url !== state.tracker.tracking_url) reject("correction_intent_scope_changed");
}
async function readRemote(request, active, binding) {
    const response = await request(active, "/graphql.json", { method: "POST", body: { query: READ, variables: { id: binding.fulfillment_gid } } });
    const data = response?.payload?.data;
    if (response?.payload?.errors?.length || !data) reject("remote_read_incomplete");
    const external = String(binding.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "");
    if (!positive(external) || data.fulfillment?.id !== binding.fulfillment_gid ||
        data.fulfillment.order?.id !== `gid://shopify/Order/${external}` || data.shop?.myshopifyDomain !== binding.store_identifier ||
        !/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/.test(data.shop?.id || "") ||
        (binding.shopify_store_gid && data.shop.id !== binding.shopify_store_gid)) reject("remote_ownership_mismatch");
    const remote = data.fulfillment;
    if (remote.deliveredAt || remote.displayStatus === "DELIVERED" || remote.events?.nodes?.some((event) => event.status === "DELIVERED")) reject("remote_delivered_inconsistent");
    if (remote.status !== "SUCCESS" || typeof remote.displayStatus !== "string" ||
        !Object.hasOwn(remote, "deliveredAt") || !Array.isArray(remote.events?.nodes) ||
        remote.events.pageInfo?.hasNextPage !== false || !Array.isArray(remote.trackingInfo) || remote.trackingInfo.length !== 1) reject("remote_layout_unsupported");
    return remote.trackingInfo[0];
}
function matchesTarget(remote, target) { return remote.number === target.number && remote.company === target.company && remote.url === target.url; }
function matchesOld(remote, tracker) {
    return remote.number === tracker.tracking_number && normalizeTrackingCarrier(remote.company) === normalizeTrackingCarrier(tracker.carrier_key) &&
        remote.url === tracker.tracking_url && Boolean(remote.company && remote.url);
}
function pendingAudit(rows) {
    for (const row of rows) {
        let record;
        try { record = JSON.parse(row.reason); } catch { continue; }
        if (record.type === "TRACKING_REBIND_V1") return record;
    }
    return null;
}
async function appendAudit(client, state, actor, record) {
    await one(client, SQL.audit, [state.binding.id, state.tracker.id, actor, JSON.stringify(record)]);
}
async function applyLocal(client, state, target, actor, record, trackingRuntimeAvailable) {
    const { tracker: old, binding, pkg } = state;
    const active = trackingRuntimeAvailable === true && Boolean(binding.enrolled_at && new Date(binding.expires_at).getTime() > Date.now());
    const fresh = await one(client, SQL.newTracker, [old.warehouse_shipment_id, old.order_id, old.account_name, old.fulfillment_location_id,
        target.carrier, target.company, afterShipCarrierSlug(target.carrier), target.number, target.url, active]);
    if (same(fresh.id, old.id)) reject("new_identity_required");
    await one(client, SQL.rebind, [pkg.id, fresh.id, target.number, old.id, binding.id, old.account_name, old.order_id, old.fulfillment_location_id, old.warehouse_shipment_id]);
    await one(client, SQL.expected, [binding.id, JSON.stringify([target.number]), old.account_name, old.order_id, binding.integration_id, binding.store_identifier]);
    await one(client, SQL.updateShipment, [old.warehouse_shipment_id, target.number, target.company, old.account_name, old.order_id, old.fulfillment_location_id]);
    await one(client, SQL.updateOrder, [old.order_id, target.number, target.company, old.account_name]);
    await appendAudit(client, state, actor, { ...record, phase: "APPLIED", newTrackerId: String(fresh.id) });
    return outcome("CORRECTED", fresh.id, null, record.correctionId);
}
async function correction(client, supplied, input, options = {}) {
    const { request, decrypt, actor } = options;
    const assertFeatures = options.assertFeatures ?? options.assertFeature;
    if (!client || typeof client.query !== "function" || typeof request !== "function" || typeof decrypt !== "function" ||
        typeof assertFeatures !== "function" || typeof actor !== "string" || !actor.trim() || actor.length > 180) reject("correction_dependencies_required", 400);
    if (!supplied || ![supplied.id, supplied.order_id, supplied.fulfillment_location_id, supplied.warehouse_shipment_id].every(positive) ||
        typeof supplied.account_name !== "string" || !supplied.account_name) reject("authorized_tracker_scope_required", 400);
    if (options.trackingRuntimeAvailable !== undefined && typeof options.trackingRuntimeAvailable !== "boolean") reject("invalid_runtime_activation_flag", 400);
    let record;
    let prepared = false;
    const target = targetInfo(input, supplied);
    const transactionState = await one(client, SQL.transactionState, [], "transaction_ownership_unverified");
    if (transactionState.already_in_transaction !== false) reject("enclosing_transaction_unsupported", 400);
    try {
        const initial = await transaction(client, async () => {
            const state = await lockedScope(client, supplied, assertFeatures);
            if (state.tracker.tracking_number !== supplied.tracking_number) reject("tracker_identity_changed");
            if ((await client.query(SQL.collision, [state.tracker.account_name, state.tracker.order_id, target.number])).rows.length) reject("tracking_identity_already_exists");
            const previous = pendingAudit((await client.query(SQL.auditRead, [state.tracker.id, state.binding.id])).rows);
            if (previous || state.tracker.manual_closed_at) {
                if (!previous || previous.phase !== "PREPARED" || !state.tracker.manual_closed_at ||
                    JSON.stringify(previous.target) !== JSON.stringify(target) || previous.userReason !== input.reason.trim()) reject("closed_identity_requires_manual_reconcile");
                record = previous;
                verifyIntent(state, record);
                return false;
            }
            const remote = await readRemote(request, await decrypt(state.store), state.binding);
            if (!matchesOld(remote, state.tracker)) reject("remote_tracking_drift");
            record = { type: "TRACKING_REBIND_V1", phase: "PREPARED", correctionId: randomUUID(), userReason: input.reason.trim(),
                binding: bindingIdentity(state),
                old: { trackerId: String(state.tracker.id), packageId: state.pkg.package_id,
                    carrier: state.tracker.carrier_key, number: state.tracker.tracking_number, url: state.tracker.tracking_url }, target };
            await one(client, SQL.close, state.scope);
            await client.query(SQL.discard, [state.binding.id, state.binding.fulfillment_gid, state.tracker.id]);
            await appendAudit(client, state, actor.trim(), record);
            return true;
        });
        prepared = true;
        return await transaction(client, async () => {
            const state = await lockedScope(client, supplied, assertFeatures);
            const current = pendingAudit((await client.query(SQL.auditRead, [state.tracker.id, state.binding.id])).rows);
            if (!state.tracker.manual_closed_at || current?.correctionId !== record.correctionId || current.phase !== "PREPARED") reject("correction_intent_changed");
            verifyIntent(state, record);
            const active = await decrypt(state.store);
            let remote = await readRemote(request, active, state.binding);
            if (matchesTarget(remote, target)) return applyLocal(client, state, target, actor.trim(), record, options.trackingRuntimeAvailable);
            if (!initial || !matchesOld(remote, state.tracker)) return outcome("NEEDS_MANUAL_RECONCILE", state.tracker.id, "remote_tracking_not_confirmed", record.correctionId);
            // Exactly one send. Even userErrors/transport failures are reconciled,
            // not retried; all local identity changes require a fresh remote read.
            try {
                await request(active, "/graphql.json", { method: "POST", body: { query: UPDATE,
                    variables: { id: state.binding.fulfillment_gid, tracking: { company: target.company, number: target.number, url: target.url } } } });
            } catch { /* The read below decides the outcome of an uncertain send. */ }
            remote = await readRemote(request, active, state.binding);
            if (matchesTarget(remote, target)) return applyLocal(client, state, target, actor.trim(), record, options.trackingRuntimeAvailable);
            return outcome("NEEDS_MANUAL_RECONCILE", state.tracker.id, "remote_tracking_not_confirmed", record.correctionId);
        });
    } catch (cause) {
        // The committed intent survives second-phase failure/rollback. A commit
        // failure is itself uncertain: parent must refresh IDs before displaying.
        return outcome(prepared || record ? "NEEDS_MANUAL_RECONCILE" : "REJECTED", supplied.id,
            cause.code && !/^[0-9A-Z]{5}$/.test(cause.code) ? cause.code : "correction_failed", record?.correctionId);
    }
}

module.exports = { correction, SQL, targetInfo };
