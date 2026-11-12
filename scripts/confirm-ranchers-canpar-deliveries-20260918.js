"use strict";

const { Client } = require("pg");
const { createShopifyTrackingApi } = require("../shopify-tracking-api");
const sync = require("../shopify-tracking-sync");
const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const PAIRS = [
    [
        "ORD-000686",
        "D420352470002684168001"
    ],
    [
        "ORD-000690",
        "D420352470002684173001"
    ],
    [
        "ORD-000691",
        "D420352470002684202001"
    ],
    [
        "ORD-000693",
        "D420352470002684206001"
    ],
    [
        "ORD-000701",
        "D420352470002684220001"
    ],
    [
        "ORD-000722",
        "D420352470002684325001"
    ],
    [
        "ORD-000734",
        "D420352470002684339001"
    ],
    [
        "ORD-000760",
        "D420352470002684367001"
    ],
    [
        "ORD-000773",
        "D420352470002690009001"
    ],
    [
        "ORD-000781",
        "D420352470002684379001"
    ],
    [
        "ORD-000803",
        "D420352470002696531001"
    ],
    [
        "ORD-000823",
        "D420352470002690024001"
    ],
    [
        "ORD-000857",
        "D420352470002696575001"
    ],
    [
        "ORD-000868",
        "D420352470002696670001"
    ]
];
const REASON = "Owner manually checked the Canpar site, explicitly confirmed delivery and approved a manual Shopify update on September 18, 2026. Actual delivery timestamp was not supplied; event time is recording time. Not automated carrier evidence.";
const MESSAGE = "Delivery manually confirmed by WMS365 ownership. Event time is recording time, not the actual delivery timestamp.";

async function transaction(client, fn) {
    await client.query("begin");
    try { const result = await fn(); await client.query("commit"); return result; }
    catch (error) { await client.query("rollback"); throw error; }
}

async function main() {
    if (process.env.CONFIRM_RANCHERS_MANUAL_DELIVERIES !== "OWNER_APPROVED_CANPAR_20260918") throw Error("Explicit approval required.");
    const requestedCode = process.argv[2];
    const selectedPairs = requestedCode ? PAIRS.filter(([code]) => code === requestedCode) : PAIRS;
    if (!selectedPairs.length) throw Error("Requested order is outside the approved batch.");
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false },
        options: "-c search_path=wms365_tracking_4,public,pg_catalog" });
    await client.connect();
    const api = createShopifyTrackingApi();
    try {
        const integration = (await client.query("select * from store_integrations where id=4")).rows[0];
        if (integration?.account_name !== ACCOUNT || integration.store_identifier !== STORE || !integration.is_active) throw Error("Integration scope mismatch.");
        await api.verify(integration);
        const readRemote = async (row) => {
            const result = await api.request(integration, "/graphql.json", { body: {
                query: `query ConfirmDelivery($id: ID!) { shop { myshopifyDomain }
                    fulfillment(id:$id) { id status displayStatus order { id } trackingInfo { number company }
                        events(first:100) { nodes { id status happenedAt } pageInfo { hasNextPage } } } }`,
                variables: { id: row.fulfillment_gid }
            } });
            const remote = result.payload.data.fulfillment;
            if (result.payload.data.shop?.myshopifyDomain !== STORE || remote?.id !== row.fulfillment_gid
                || remote.order?.id !== `gid://shopify/Order/${row.external_order_id}`
                || remote.status !== "SUCCESS" || remote.trackingInfo.length !== 1
                || remote.trackingInfo[0].number !== row.tracking_number
                || !/CANPAR/i.test(remote.trackingInfo[0].company || "")
                || remote.events.pageInfo.hasNextPage) throw Error("Remote ownership/package verification failed.");
            return remote;
        };
        const rows = [];
        // Verify every requested identity before recording any manual confirmations.
        for (const [code, number] of selectedPairs) {
            const result = await client.query(`select o.order_code,o.status order_status,t.id tracker_id,t.tracking_number,
                t.carrier_key,t.fulfillment_location_id,t.claimed_at,t.manual_closed_at,f.*
                from portal_orders o join shipment_trackers t on t.order_id=o.id and t.account_name=o.account_name
                join shopify_tracking_packages p on p.tracker_id=t.id and p.account_name=t.account_name
                join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id and f.account_name=p.account_name
                where o.order_code=$1 and o.account_name=$2 and t.tracking_number=$3 and f.integration_id=4`, [code, ACCOUNT, number]);
            const row = result.rows[0];
            if (result.rowCount !== 1 || row.order_status !== "SHIPPED" || row.carrier_key !== "CANPAR"
                || String(row.fulfillment_location_id) !== "1" || row.account_name !== ACCOUNT
                || row.store_identifier !== STORE || row.expected_tracking_numbers.length !== 1
                || row.expected_tracking_numbers[0] !== number) throw Error(`Scope mismatch: ${code}`);
            await readRemote(row);
            rows.push(row);
        }
        const outcomes = [];
        for (const row of rows) {
            try {
                await client.query("select pg_advisory_lock(hashtext($1))", [`owner-delivery:${row.id}`]);
                const pending = await transaction(client, async () => {
                    const locked = (await client.query("select * from shipment_trackers where id=$1 and account_name=$2 for update", [row.tracker_id, ACCOUNT])).rows[0];
                    if (locked.tracking_number !== row.tracking_number || locked.claimed_at) throw Error("Tracker identity changed or carrier poll running; retry later.");
                    const key = `OWNER-DELIVERED-20260918:${row.order_code}:${row.tracking_number}`;
                    const event = (await client.query(`insert into shipment_tracking_events
                        (tracker_id,event_key,status,description,event_at,source,safe_metadata)
                        values($1,$2,'DELIVERED',$3,now(),'OWNER_CONFIRMATION',$4::jsonb)
                        on conflict(tracker_id,event_key) do update set event_key=excluded.event_key returning id,event_at`,
                    [row.tracker_id, key, MESSAGE, JSON.stringify({ carrier_scan: false, owner_confirmed: true,
                        time_basis: "OWNER_CONFIRMATION_RECORDING_TIME", approval_reference: "20260918-14-CANPAR-DELIVERIES" })])).rows[0];
                    const audit = await client.query(`select id from shopify_tracking_corrections where fulfillment_binding_id=$1
                        and tracker_id=$2 and action='MANUAL_CLOSE' and reason=$3`, [row.id, row.tracker_id, REASON]);
                    if (!audit.rows.length) await sync.correctTracker(client, row.tracker_id, { action: "MANUAL_CLOSE", reason: REASON, actor: "WMS365 owner request" });
                    await client.query(`update shipment_trackers set status='DELIVERED',status_detail=$2,last_event_at=$3,
                        next_poll_at=null,is_active=false,last_error='',attempts=0,updated_at=now() where id=$1`, [row.tracker_id, MESSAGE, event.event_at]);
                    await client.query(`update shopify_tracking_packages set confirmed_delivered_at=$3,delivery_event_id=$4
                        where fulfillment_binding_id=$1 and tracker_id=$2`, [row.id, row.tracker_id, event.event_at, event.id]);
                    return (await client.query(`insert into shopify_tracking_outbox
                        (fulfillment_binding_id,fulfillment_gid,status,event_at,source_event_id,state,last_error,notifications_enqueued_at)
                        values($1,$2,'DELIVERED',$3,$4,'BLOCKED','Explicit owner manual update; handled outside automatic carrier-evidence publisher.',now())
                        on conflict(fulfillment_binding_id,fulfillment_gid,status,event_at) do update set fulfillment_gid=excluded.fulfillment_gid
                        returning *`, [row.id, row.fulfillment_gid, event.event_at, event.id])).rows[0];
                });
                let remote = await readRemote(row);
                let delivered = remote.events.nodes.find((e) => e.status === "DELIVERED");
                let created = false;
                if (!delivered) {
                    const result = await api.request(integration, "/graphql.json", { body: {
                        query: `mutation OwnerDelivery($event: FulfillmentEventInput!) {
                            fulfillmentEventCreate(fulfillmentEvent:$event) { fulfillmentEvent { id } userErrors { field message } } }`,
                        variables: { event: { fulfillmentId: row.fulfillment_gid, status: "DELIVERED",
                            happenedAt: new Date(pending.event_at).toISOString(), message: MESSAGE } }
                    } });
                    const mutation = result.payload.data.fulfillmentEventCreate;
                    if (mutation?.userErrors?.length || !mutation?.fulfillmentEvent?.id) throw Error("Shopify rejected delivery event.");
                    created = true;
                    remote = await readRemote(row);
                    delivered = remote.events.nodes.find((e) => e.status === "DELIVERED");
                }
                if (!delivered || remote.displayStatus !== "DELIVERED") throw Error("Shopify delivered readback not confirmed; reconcile before retry.");
                await client.query(`update shopify_tracking_outbox set state='SENT',remote_event_gid=$2,
                    sent_at=coalesce(sent_at,now()),last_attempt_at=now(),attempts=attempts+1,last_error='',
                    notification_state='REQUESTED' where id=$1`, [pending.id, delivered.id]);
                await client.query("update shopify_tracking_fulfillments set last_shopify_check_at=now() where id=$1", [row.id]);
                outcomes.push({ order: row.order_code, wmsTracking: "DELIVERED", shopifyStatus: remote.displayStatus, createdEvent: created });
            } catch (error) {
                outcomes.push({ order: row.order_code, error: error.message });
            } finally {
                await client.query("select pg_advisory_unlock(hashtext($1))", [`owner-delivery:${row.id}`]);
            }
            console.log(JSON.stringify(outcomes[outcomes.length - 1]));
        }
        console.log(JSON.stringify({ verifiedDelivered: outcomes.filter((o) => o.shopifyStatus === "DELIVERED").length,
            failed: outcomes.filter((o) => o.error).length, total: selectedPairs.length }));
        if (outcomes.some((o) => o.error)) process.exitCode = 1;
    } finally { await client.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
