"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WINDOW_DAYS = 45;
const POLL_MINUTES = 45;
const MAX_ATTEMPTS = 12;
const CARRIER_SCAN_SOURCES = Object.freeze(["AFTERSHIP", "CANPAR_BROWSER", "ICS_COURIER_BROWSER", "GLS_BROWSER"]);
const STATUS_MAP = Object.freeze({
    PICKED_UP: "CARRIER_PICKED_UP", IN_TRANSIT: "IN_TRANSIT", EXCEPTION: "DELAYED",
    OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY", DELIVERY_ATTEMPTED: "ATTEMPTED_DELIVERY", DELIVERED: "DELIVERED"
});

function iso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fulfillmentGid(value) {
    const text = String(value || "");
    if (/^gid:\/\/shopify\/Fulfillment\/\d+$/.test(text)) return text;
    return /^\d+$/.test(text) ? `gid://shopify/Fulfillment/${text}` : null;
}

function deliverySettings(integration = {}) {
    return {
        carrierFulfillmentEventsEnabled: integration.settings?.carrierFulfillmentEventsEnabled === true,
        trackingWindowDays: boundedInteger(integration.settings?.trackingWindowDays, 1, 180, WINDOW_DAYS),
        trackingPollMinutes: boundedInteger(integration.settings?.trackingPollMinutes, 30, 60, POLL_MINUTES),
        shopifySendState: "UNKNOWN"
    };
}

function boundedInteger(value, min, max, fallback) {
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function isCarrierScan(event = {}) {
    return CARRIER_SCAN_SOURCES.includes(event.source) && event.safe_metadata?.carrier_scan === true && Boolean(iso(event.event_at));
}

function mapCarrierEvent(event = {}) {
    return isCarrierScan(event) ? STATUS_MAP[event.status] || null : null;
}

function allPackagesDelivered(expected = [], packages = []) {
    return expected.length > 0 && expected.every((number) => {
        const matches = packages.filter((entry) => entry.tracking_number === number);
        return matches.length === 1 && Boolean(matches[0].delivery_event_id && iso(matches[0].confirmed_delivered_at));
    });
}

function retryAt(attempts, now = new Date()) {
    return new Date(new Date(now).getTime() + Math.min(24 * 60, 2 ** Math.min(Math.max(1, attempts), 11)) * 60000).toISOString();
}

function enrolledPollAt(binding, status, now = new Date(), attempts = 0, manualClosedAt = null) {
    if (!binding?.enrolled_at) return undefined;
    const expiry = iso(binding.expires_at);
    if (!expiry || new Date(expiry) <= new Date(now) || status === "DELIVERED" || manualClosedAt || binding.manual_closed_at) return null;
    const minutes = boundedInteger(binding.tracking_poll_minutes, 30, 60, POLL_MINUTES);
    const next = new Date(new Date(now).getTime() + Math.max(minutes, attempts ? Math.min(1440, 2 ** Math.min(attempts, 11)) : 0) * 60000);
    return next < new Date(expiry) ? next.toISOString() : expiry;
}

async function initializeSchema(client) {
    await client.query(fs.readFileSync(path.join(__dirname, "migrations", "20260917_shopify_tracking_sync.sql"), "utf8"));
}

async function bindingForTracker(client, trackerId) {
    const result = await client.query(`select f.*, p.id as binding_package_id, p.package_id,
        p.warehouse_shipment_id, p.fulfillment_location_id, p.confirmed_delivered_at,t.manual_closed_at,
        i.is_active as integration_active, i.settings as integration_settings
        from shopify_tracking_packages p join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id
        join shipment_trackers t on t.id=p.tracker_id and t.account_name=p.account_name
            and t.order_id=p.order_id and t.fulfillment_location_id=p.fulfillment_location_id and t.warehouse_shipment_id=p.warehouse_shipment_id
        join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name and i.store_identifier=f.store_identifier
        where p.tracker_id=$1 order by f.id`, [trackerId]);
    return result.rows;
}

async function bindFulfillment(client, integration, order, externalOrderId, fulfillment, trackingNumbers, shopInfo = {}) {
    const gid = fulfillmentGid(fulfillment?.admin_graphql_api_id || fulfillment?.id);
    if (!gid) throw new Error("Shopify fulfillment response did not include a valid fulfillment ID.");
    if (integration.account_name !== order.accountName) throw new Error("Shopify binding company mismatch.");
    const expected = [...new Set(trackingNumbers.map(String).filter(Boolean))];
    if (!expected.length) return null;
    const enabled = deliverySettings(integration).carrierFulfillmentEventsEnabled;
    const settings = deliverySettings(integration);
    const result = await client.query(`insert into shopify_tracking_fulfillments
        (integration_id,store_identifier,account_name,order_id,external_order_id,fulfillment_gid,expected_tracking_numbers,enrolled_at,expires_at,
            tracking_started_at,tracking_poll_minutes,tracking_window_days)
        select i.id,i.store_identifier,i.account_name,o.id,$3,$4,$5::jsonb,
            case when $6 then now() end,case when $6 then coalesce(o.shipped_at,now())+($8 * interval '1 day') end,
            coalesce(o.shipped_at,now()),$7,$8
        from store_integrations i join portal_orders o on o.account_name=i.account_name
        join store_order_imports imp on imp.integration_id=i.id and imp.portal_order_id=o.id and imp.external_order_id=$3
        where i.id=$1 and o.id=$2 and i.provider='SHOPIFY'
        on conflict (integration_id,fulfillment_gid) do update set
            expected_tracking_numbers=excluded.expected_tracking_numbers,updated_at=now()
        where shopify_tracking_fulfillments.order_id=excluded.order_id
          and shopify_tracking_fulfillments.account_name=excluded.account_name
          and shopify_tracking_fulfillments.external_order_id=excluded.external_order_id
          and shopify_tracking_fulfillments.store_identifier=excluded.store_identifier
        returning *`, [integration.id, order.id, String(externalOrderId), gid, JSON.stringify(expected), enabled, settings.trackingPollMinutes, settings.trackingWindowDays]);
    if (result.rows.length !== 1) throw new Error("Shopify binding ownership could not be verified.");
    const binding = result.rows[0];
    const shopGid = /^gid:\/\/shopify\/Shop\/\d+$/.test(String(shopInfo.id || "")) ? shopInfo.id : "";
    await client.query(`update shopify_tracking_fulfillments set shopify_store_gid=coalesce(nullif($2,''),shopify_store_gid),
        shopify_store_name=coalesce(nullif($3,''),shopify_store_name),shopify_notification_state=$4 where id=$1`,
        [binding.id, shopGid, String(shopInfo.name || "").slice(0, 240), shopInfo.notificationRequested === true ? "REQUESTED" : "UNKNOWN"]);
    await client.query(`insert into shopify_tracking_packages
        (fulfillment_binding_id,account_name,order_id,fulfillment_location_id,warehouse_shipment_id,tracker_id,package_id,tracking_number)
        select $1,t.account_name,t.order_id,t.fulfillment_location_id,t.warehouse_shipment_id,t.id,t.id::text,t.tracking_number
        from shipment_trackers t join warehouse_shipments s on s.id=t.warehouse_shipment_id
          and s.account_name=t.account_name and s.order_id=t.order_id and s.fulfillment_location_id=t.fulfillment_location_id
        where t.order_id=$2 and t.account_name=$3 and t.tracking_number=any($4::text[]) and s.status='SHIPPED'
          and not exists (select 1 from shipment_trackers other join warehouse_shipments os on os.id=other.warehouse_shipment_id
              where other.order_id=t.order_id and other.account_name=t.account_name and other.tracking_number=t.tracking_number
                and other.id<>t.id and os.status='SHIPPED')
        on conflict (fulfillment_binding_id,tracking_number) do nothing`, [binding.id, order.id, order.accountName, expected]);
    if (binding.enrolled_at && enabled) {
        await client.query(`update shipment_trackers t set next_poll_at=case when t.status='DELIVERED' then null else coalesce(t.next_poll_at,now()) end,
            is_active=t.manual_closed_at is null and t.status<>'DELIVERED'
            from shopify_tracking_packages p where p.fulfillment_binding_id=$1 and p.tracker_id=t.id
              and $2::timestamptz>now() and t.claimed_at is null and t.manual_closed_at is null`, [binding.id, binding.expires_at]);
        await queueBindingEvents(client, binding.id);
    }
    return binding;
}

async function queueBindingEvents(client, bindingId) {
    const locked = await client.query("select * from shopify_tracking_fulfillments where id=$1 for update", [bindingId]);
    const binding = locked.rows[0];
    if (!binding?.enrolled_at || new Date(binding.expires_at) <= new Date()) return 0;
    const integration = await client.query("select * from store_integrations where id=$1 and account_name=$2 and store_identifier=$3", [binding.integration_id, binding.account_name, binding.store_identifier]);
    if (!integration.rows[0]?.is_active || !deliverySettings(integration.rows[0]).carrierFulfillmentEventsEnabled) return 0;
    await client.query(`update shopify_tracking_packages p set confirmed_delivered_at=null,delivery_event_id=null
        where p.fulfillment_binding_id=$1 and p.delivery_event_id is not null and exists (
          select 1 from shipment_tracking_events newer where newer.tracker_id=p.tracker_id
          and newer.event_at>p.confirmed_delivered_at and newer.safe_metadata->>'carrier_scan'='true'
          and newer.status<>'DELIVERED')`, [binding.id]);
    await client.query(`update shopify_tracking_packages p set confirmed_delivered_at=e.event_at, delivery_event_id=e.id
        from shipment_tracking_events e
        where p.fulfillment_binding_id=$1 and e.tracker_id=p.tracker_id and e.status='DELIVERED'
          and e.source in ('AFTERSHIP','CANPAR_BROWSER','ICS_COURIER_BROWSER','GLS_BROWSER') and e.safe_metadata->>'carrier_scan'='true'
          and e.event_at<=$2 and e.event_at<=now()
          and (p.confirmed_delivered_at is null or e.event_at>p.confirmed_delivered_at)
          and not exists (select 1 from shipment_tracking_events newer where newer.tracker_id=e.tracker_id
              and newer.event_at>e.event_at and newer.safe_metadata->>'carrier_scan'='true')
          and not exists (select 1 from shopify_tracking_corrections c where c.tracker_id=p.tracker_id
              and c.fulfillment_binding_id=p.fulfillment_binding_id and c.action='INVALIDATE_DELIVERY' and c.created_at>=e.created_at)`, [binding.id, binding.expires_at]);
    const events = await client.query(`select e.* from shipment_tracking_events e
        join shopify_tracking_packages p on p.tracker_id=e.tracker_id
        where p.fulfillment_binding_id=$1 and e.event_at<=$2 and e.event_at<=now() and e.event_at>=$4
          and p.tracking_number in (select jsonb_array_elements_text($3::jsonb))
        order by e.event_at,e.id`, [binding.id, binding.expires_at, JSON.stringify(binding.expected_tracking_numbers), binding.enrolled_at]);
    const packages = await client.query("select * from shopify_tracking_packages where fulfillment_binding_id=$1", [binding.id]);
    let count = 0;
    for (const event of events.rows) {
        const status = mapCarrierEvent(event);
        if (!status || status === "DELIVERED") continue;
        const inserted = await insertOutbox(client, binding, status, event.event_at, event.id);
        count += inserted;
    }
    if (allPackagesDelivered(binding.expected_tracking_numbers, packages.rows)) {
        const last = packages.rows.filter((p) => binding.expected_tracking_numbers.includes(p.tracking_number))
            .sort((a, b) => new Date(b.confirmed_delivered_at) - new Date(a.confirmed_delivered_at))[0];
        const approved = binding.historical_delivery_approved_at ? await client.query(`select p.id
            from shopify_tracking_packages p join shipment_tracking_events e on e.id=p.delivery_event_id and e.tracker_id=p.tracker_id
            join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id
            where p.fulfillment_binding_id=$1 and e.created_at>=f.historical_delivery_approved_at and e.safe_metadata->>'carrier_scan'='true'
              and e.safe_metadata->>'time_basis'='CARRIER_OFFSET_TIMESTAMP'
              and exists(select 1 from shopify_tracking_corrections c where c.fulfillment_binding_id=p.fulfillment_binding_id
                  and c.tracker_id=p.tracker_id and c.action='REPLAY_EVENTS' and c.created_at<=f.historical_delivery_approved_at)`,
            [binding.id]) : {rows:[]};
        const historical = binding.historical_delivery_approved_at && binding.expected_tracking_numbers.length===approved.rows.length;
        if (new Date(last.confirmed_delivered_at) >= new Date(binding.enrolled_at) || historical) {
            count += await insertOutbox(client, binding, "DELIVERED", last.confirmed_delivered_at, last.delivery_event_id);
        }
    }
    return count;
}

async function insertOutbox(client, binding, status, at, eventId) {
    const result = await client.query(`insert into shopify_tracking_outbox
        (fulfillment_binding_id,fulfillment_gid,status,event_at,source_event_id)
        select $1,$2,$3,$4,$5 where not exists
          (select 1 from shopify_tracking_outbox sent where sent.fulfillment_binding_id=$1 and sent.state='SENT'
            and exists (select 1 from shipment_tracking_events evidence join shopify_tracking_packages current_package
              on current_package.tracker_id=evidence.tracker_id and current_package.fulfillment_binding_id=sent.fulfillment_binding_id
              where evidence.id=sent.source_event_id)
            and (sent.status='DELIVERED' or sent.event_at>$4::timestamptz))
        on conflict do nothing returning id`, [binding.id, binding.fulfillment_gid, status, at, eventId]);
    return result.rows.length;
}

async function queueTrackerEvents(client, trackerId) {
    const bindings = await bindingForTracker(client, trackerId);
    for (const binding of bindings) await queueBindingEvents(client, binding.id);
    return bindings;
}

async function graphql(request, integration, query, variables) {
    const result = await request(integration, "/graphql.json", { method: "POST", body: { query, variables } });
    if (result.payload?.errors?.length || !result.payload?.data) throw new Error("Shopify tracking GraphQL request failed.");
    return result.payload.data;
}

async function reconcileEvent(request, integration, binding, row) {
    let cursor = null;
    const cursors = new Set();
    for (let page = 0; page < 100; page += 1) {
        const data = await graphql(request, integration, `query TrackingEvents($id: ID!, $after: String) {
            fulfillment(id: $id) { id order { id } events(first: 100, after: $after) {
                nodes { id status happenedAt } pageInfo { hasNextPage endCursor }
            } }
        }`, { id: binding.fulfillment_gid, after: cursor });
        const fulfillment = data.fulfillment;
        const orderId = String(binding.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "");
        if (fulfillment?.id !== binding.fulfillment_gid || fulfillment.order?.id !== `gid://shopify/Order/${orderId}`) {
            throw new Error("Shopify fulfillment/order ownership could not be reconciled.");
        }
        const connection = fulfillment.events;
        if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
            throw new Error("Shopify fulfillment event reconciliation was incomplete.");
        }
        const match = connection.nodes.find((event) => event.status === row.status && iso(event.happenedAt) === iso(row.event_at));
        if (match?.id) return match.id;
        const delivered = connection.nodes.find((event) => event.status === "DELIVERED" && event.id);
        if (delivered && row.status === "DELIVERED") return delivered.id;
        if (delivered) throw new Error("Shopify fulfillment is already delivered; refuse a status regression.");
        if (!connection.pageInfo.hasNextPage) return null;
        cursor = connection.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Shopify event pagination did not advance.");
        cursors.add(cursor);
    }
    throw new Error("Shopify event reconciliation exceeded the safe pagination limit.");
}

function carrierEventMessage(evidence = []) {
    const observed=evidence.filter((e)=>e.safe_metadata?.time_basis==="OBSERVED_CONFIRMED_STATUS");
    if(!observed.length) return "Carrier-confirmed shipment status.";
    const times=[...new Set(observed.map((e)=>e.safe_metadata.carrier_local_timestamp))];
    if(times.some((t)=>!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t || ""))) throw new Error("RECORDED_SCAN_TIME_MISSING");
    return `Carrier-confirmed status recorded by WMS365. Event time is recording time, not actual delivery time. Original carrier-local scan time(s), timezone unverified: ${times.join("; ")}.`;
}

async function processOne(client, { request, decrypt = (row) => row, assertFeatures = async () => {}, integrationId = null }) {
    // Row and fulfillment locks span reconciliation and mutation. Every attempt reconciles,
    // including first sends and process crashes, so a lost response never blindly replays.
    const due = await client.query(`select o.* from shopify_tracking_outbox o
        join shopify_tracking_fulfillments f on f.id=o.fulfillment_binding_id
        join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name and i.store_identifier=f.store_identifier
        where o.state in ('PENDING','RETRY') and o.discarded_at is null and o.next_attempt_at<=now()
          and ($1::bigint is null or i.id=$1)
          and f.enrolled_at is not null and i.is_active and i.settings->>'carrierFulfillmentEventsEnabled'='true'
          and not exists (select 1 from shopify_tracking_packages closed
              join shipment_trackers t on t.id=closed.tracker_id
              where closed.fulfillment_binding_id=f.id and t.manual_closed_at is not null)
          and not exists (select 1 from shopify_tracking_outbox prior where prior.fulfillment_binding_id=o.fulfillment_binding_id
              and prior.state<>'SENT' and prior.discarded_at is null and (prior.event_at,prior.id)<(o.event_at,o.id))
        order by o.event_at,o.id for update of o skip locked limit 1`, [integrationId]);
    const row = due.rows[0];
    if (!row) return null;
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtext('shopify-tracking'), $1::integer) as locked", [row.fulfillment_binding_id]);
    if (!lock.rows[0]?.locked) return null;
    const locked = await client.query("select * from shopify_tracking_fulfillments where id=$1 for update", [row.fulfillment_binding_id]);
    const binding = locked.rows[0];
    const integrations = await client.query("select * from store_integrations where id=$1 and account_name=$2 and store_identifier=$3 for share", [binding.integration_id, binding.account_name, binding.store_identifier]);
    const integration = integrations.rows[0];
    if (!integration?.is_active || !deliverySettings(integration).carrierFulfillmentEventsEnabled) return null;
    const closed = await client.query(`select t.id from shopify_tracking_packages p
        join shipment_trackers t on t.id=p.tracker_id where p.fulfillment_binding_id=$1
          and t.manual_closed_at is not null limit 1`, [binding.id]);
    if (closed.rows.length) return null;
    const attempts = Number(row.attempts) + 1;
    try {
        await assertFeatures(client, binding.account_name);
        const obsolete = await client.query(`select id from shopify_tracking_outbox
            where fulfillment_binding_id=$1 and state='SENT' and id<>$2
              and exists (select 1 from shipment_tracking_events evidence join shopify_tracking_packages current_package
                on current_package.tracker_id=evidence.tracker_id and current_package.fulfillment_binding_id=shopify_tracking_outbox.fulfillment_binding_id
                where evidence.id=shopify_tracking_outbox.source_event_id)
              and (status='DELIVERED' or event_at>$3::timestamptz) limit 1`, [binding.id, row.id, row.event_at]);
        if (obsolete.rows.length) {
            await client.query("update shopify_tracking_outbox set state='BLOCKED',discarded_at=now(),last_error='Superseded by a newer published carrier event.' where id=$1", [row.id]);
            return { id: row.id, state: "DISCARDED" };
        }
        if (row.status === "DELIVERED") {
            const invalidated = await client.query(`select c.id from shopify_tracking_corrections c
                join shipment_tracking_events e on e.tracker_id=c.tracker_id
                where c.fulfillment_binding_id=$1 and c.action='INVALIDATE_DELIVERY'
                  and e.id=$2 and c.created_at>=e.created_at limit 1`, [binding.id, row.source_event_id]);
            if (invalidated.rows.length) {
                await client.query("update shopify_tracking_outbox set state='BLOCKED',discarded_at=now(),last_error='Original delivery evidence was invalidated.' where id=$1", [row.id]);
                return { id: row.id, state: "DISCARDED" };
            }
            const packages = await client.query("select * from shopify_tracking_packages where fulfillment_binding_id=$1", [binding.id]);
            if (!allPackagesDelivered(binding.expected_tracking_numbers, packages.rows)) {
                await client.query("update shopify_tracking_outbox set state='BLOCKED',last_error='Expected packages are not all carrier-confirmed delivered.' where id=$1", [row.id]);
                return { id: row.id, state: "BLOCKED" };
            }
        }
        const active = decrypt(integration);
        let remoteId = await reconcileEvent(request, active, binding, row);
        await client.query("update shopify_tracking_fulfillments set last_shopify_check_at=now() where id=$1", [binding.id]);
        if (!remoteId) {
            const evidence=await client.query(`select e.safe_metadata from shipment_tracking_events e
                join shopify_tracking_packages p on p.tracker_id=e.tracker_id
                where p.fulfillment_binding_id=$1 and
                  (e.id=$2 or ($3='DELIVERED' and e.id=p.delivery_event_id))`,[binding.id,row.source_event_id,row.status]);
            if(evidence.rows.some((e)=>e.safe_metadata?.time_basis==="OBSERVED_CONFIRMED_STATUS")
                && integration.settings?.carrierUnverifiedTimeMode!=="OBSERVED") throw new Error("RECORDED_TIME_APPROVAL_DISABLED");
            const data = await graphql(request, active, `mutation TrackingEvent($event: FulfillmentEventInput!) {
                fulfillmentEventCreate(fulfillmentEvent: $event) { fulfillmentEvent { id } userErrors { field message } }
            }`, { event: { fulfillmentId: binding.fulfillment_gid, status: row.status, happenedAt: iso(row.event_at),
                message:carrierEventMessage(evidence.rows) } });
            const mutation = data.fulfillmentEventCreate;
            if (mutation?.userErrors?.length || !mutation?.fulfillmentEvent?.id) throw new Error("Shopify did not accept the carrier fulfillment event.");
            remoteId = mutation.fulfillmentEvent.id;
        }
        await client.query(`update shopify_tracking_outbox set state='SENT',remote_event_gid=$2,sent_at=now(),
            notification_state='REQUESTED',attempts=$3,last_attempt_at=now(),last_error='' where id=$1`, [row.id, remoteId, attempts]);
        return { id: row.id, state: "SENT", notificationState: "REQUESTED", sendState: "UNKNOWN" };
    } catch (_error) {
        // Do not persist remote payloads, credentials or Shopify error text in customer-visible state.
        const state = attempts >= MAX_ATTEMPTS ? "BLOCKED" : "RETRY";
        await client.query(`update shopify_tracking_outbox set state=$2,attempts=$3,last_attempt_at=now(),
            next_attempt_at=$4,last_error='Shopify carrier event check/send failed; reconciliation required before retry.' where id=$1`, [row.id, state, attempts, retryAt(attempts)]);
        return { id: row.id, state };
    }
}

async function trackerSyncState(client, trackerId) {
    const bindings = await bindingForTracker(client, trackerId);
    const states = [];
    for (const binding of bindings) {
        const result = await client.query("select * from shopify_tracking_outbox where fulfillment_binding_id=$1 order by event_at desc,id desc limit 1", [binding.id]);
        const row = result.rows[0];
        const successful = await client.query("select status,sent_at from shopify_tracking_outbox where fulfillment_binding_id=$1 and state='SENT' order by sent_at desc,id desc limit 1", [binding.id]);
        states.push({
            bindingId: String(binding.id), integrationId: String(binding.integration_id), storeIdentifier: binding.store_identifier,
            shopifyStoreGid: binding.shopify_store_gid || "", shopifyStoreName: binding.shopify_store_name || "",
            externalOrderId: binding.external_order_id, fulfillmentGid: binding.fulfillment_gid,
            shipmentId: String(binding.warehouse_shipment_id), packageId: binding.package_id,
            enabled: binding.integration_active === true && binding.integration_settings?.carrierFulfillmentEventsEnabled === true,
            enrolledAt: iso(binding.enrolled_at), expiresAt: iso(binding.expires_at),
            lastShopifyCheckAt: iso(binding.last_shopify_check_at), lastSuccessfulAt: iso(successful.rows[0]?.sent_at),
            lastSuccessfullySentStatus: successful.rows[0]?.status || null,
            confirmedDeliveredAt: iso(binding.confirmed_delivered_at),
            state: row?.state || "IDLE", status: row?.status || null, lastError: row?.last_error || "",
            lastAttemptAt: iso(row?.last_attempt_at), nextAttemptAt: row && row.state !== "SENT" ? iso(row.next_attempt_at) : null,
            notificationState: row?.notification_state || "PENDING", sendState: "UNKNOWN",
            trackingWindowDays: binding.tracking_window_days, trackingPollMinutes: binding.tracking_poll_minutes,
            manualClosedAt: iso(binding.manual_closed_at)
        });
    }
    return states;
}

async function resendTracker(client, trackerId) {
    const bindings = await queueTrackerEvents(client, trackerId);
    for (const binding of bindings) {
        if (!binding.enrolled_at || !binding.integration_active || binding.integration_settings?.carrierFulfillmentEventsEnabled !== true) continue;
        await client.query(`update shopify_tracking_outbox set state='RETRY',attempts=0,next_attempt_at=now(),last_error=''
            where fulfillment_binding_id=$1 and discarded_at is null and state in ('RETRY','BLOCKED')`, [binding.id]);
    }
    return trackerSyncState(client, trackerId);
}

async function correctTracker(client, trackerId, { action, reason, actor }) {
    if (!["INVALIDATE_DELIVERY", "REPLAY_EVENTS", "MANUAL_CLOSE", "REOPEN_TRACKING"].includes(action) || !String(reason || "").trim()) {
        throw Object.assign(new Error("A supported correction action and reason are required."), { statusCode: 400 });
    }
    const bindings = await bindingForTracker(client, trackerId);
    if (action === "MANUAL_CLOSE") {
        await client.query("update shipment_trackers set manual_closed_at=now(),is_active=false,next_poll_at=null,claimed_by='',claimed_at=null where id=$1", [trackerId]);
    } else if (action === "REOPEN_TRACKING") {
        await client.query("update shipment_trackers set manual_closed_at=null,is_active=true,next_poll_at=now(),attempts=0 where id=$1", [trackerId]);
    }
    for (const binding of bindings) {
        await client.query("select id from shopify_tracking_fulfillments where id=$1 for update", [binding.id]);
        await client.query("insert into shopify_tracking_corrections (fulfillment_binding_id,tracker_id,actor,reason,action) values ($1,$2,$3,$4,$5)", [binding.id, trackerId, String(actor || "Warehouse admin").slice(0, 180), String(reason).trim().slice(0, 600), action]);
        if (action === "INVALIDATE_DELIVERY") {
            await client.query("update shopify_tracking_packages set confirmed_delivered_at=null,delivery_event_id=null where fulfillment_binding_id=$1 and tracker_id=$2", [binding.id, trackerId]);
            await client.query("update shopify_tracking_outbox set state='BLOCKED',discarded_at=now(),last_error='Delivery evidence invalidated by administrator.' where fulfillment_binding_id=$1 and status='DELIVERED' and state<>'SENT'", [binding.id]);
        }
    }
    if (action === "REPLAY_EVENTS") await resendTracker(client, trackerId);
    return trackerSyncState(client, trackerId);
}

module.exports = { WINDOW_DAYS, POLL_MINUTES, STATUS_MAP, deliverySettings, fulfillmentGid,
    CARRIER_SCAN_SOURCES,
    isCarrierScan, mapCarrierEvent, allPackagesDelivered, retryAt, enrolledPollAt, initializeSchema,
    bindFulfillment, bindingForTracker, queueTrackerEvents, processOne, reconcileEvent,
    trackerSyncState, resendTracker, correctTracker, carrierEventMessage };
