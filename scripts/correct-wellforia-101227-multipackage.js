const { Pool } = require("pg");
const { buildCarrierTrackingUrl } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const ORDER_CODE = "S-ORD101227";
const PACKAGES = ["1ZV56D262041257724", "1ZV56D262061669135"];
const TRACKING_REFERENCE = PACKAGES.join(", ");

async function snapshot(client, lock = false) {
    const orderResult = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                o.shipped_carrier_name,o.shipped_tracking_reference
           from portal_orders o where o.account_name=$1 and o.order_code=$2
           ${lock ? "for update" : ""}`,
        [ACCOUNT, ORDER_CODE]
    );
    if (orderResult.rowCount !== 1) throw new Error("Exact Wellforia order identity failed.");
    const order = orderResult.rows[0];
    if (order.status !== "SHIPPED" || order.shipped_carrier_name !== "UPS") throw new Error("Shipment status or carrier changed.");
    const shipmentResult = await client.query(
        `select id,order_id,status,carrier_name,tracking_reference
           from warehouse_shipments where order_id=$1 order by id desc`, [order.id]
    );
    if (shipmentResult.rowCount !== 1) throw new Error(`Expected one warehouse shipment; found ${shipmentResult.rowCount}.`);
    const trackers = (await client.query(
        `select id,carrier_name,tracking_number,tracking_url,is_active
           from shipment_trackers where warehouse_shipment_id=$1 order by id`, [shipmentResult.rows[0].id]
    )).rows;
    const duplicates = (await client.query(
        `select distinct o.order_code,trim(x.package_number) package_number
           from portal_orders o cross join lateral regexp_split_to_table(coalesce(o.shipped_tracking_reference,''), E'[\\n,;|]+') x(package_number)
          where upper(trim(x.package_number))=any($1::text[]) and o.id<>$2`,
        [PACKAGES, order.id]
    )).rows;
    return { order, shipment: shipmentResult.rows[0], trackers, duplicates };
}

function verifyExact(state) {
    const active = state.trackers.filter((row) => row.is_active === true);
    const numbers = active.map((row) => row.tracking_number).sort();
    return state.order.shipped_tracking_reference === TRACKING_REFERENCE
        && state.shipment.tracking_reference === TRACKING_REFERENCE
        && JSON.stringify(numbers) === JSON.stringify([...PACKAGES].sort())
        && active.every((row) => row.carrier_name === "UPS" && row.tracking_url);
}

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false, max: 1 });
    const client = await pool.connect();
    try {
        await client.query("begin");
        const before = await snapshot(client, APPLY);
        if (before.duplicates.length) throw new Error(`Tracking already belongs to another order: ${JSON.stringify(before.duplicates)}`);
        if (!APPLY) {
            await client.query("rollback");
            console.log(JSON.stringify({ mode: "preflight", exact: verifyExact(before), before }, null, 2));
            return;
        }
        await client.query(`update portal_orders set shipped_tracking_reference=$2,updated_at=now() where id=$1`, [before.order.id, TRACKING_REFERENCE]);
        await client.query(`update warehouse_shipments set tracking_reference=$2,updated_at=now() where id=$1`, [before.shipment.id, TRACKING_REFERENCE]);
        const trackerIds = [];
        for (const tracking of PACKAGES) {
            const url = buildCarrierTrackingUrl("UPS", tracking);
            if (!url) throw new Error(`No UPS tracking URL for ${tracking}.`);
            const result = await client.query(
                `insert into shipment_trackers (
                    warehouse_shipment_id,order_id,account_name,fulfillment_location_id,provider_key,
                    carrier_key,carrier_name,carrier_slug,tracking_number,tracking_url,status,next_poll_at
                 ) values ($1,$2,$3,$4,'AFTERSHIP','UPS','UPS','ups',$5,$6,'PENDING',now())
                 on conflict (warehouse_shipment_id,tracking_number) do update set
                    carrier_key='UPS',carrier_name='UPS',carrier_slug='ups',tracking_url=excluded.tracking_url,
                    is_active=true,updated_at=now() returning id`,
                [before.shipment.id, before.order.id, ACCOUNT, before.order.fulfillment_location_id, tracking, url]
            );
            trackerIds.push(result.rows[0].id);
        }
        await client.query(
            `update shipment_trackers set is_active=false,next_poll_at=null,updated_at=now()
              where warehouse_shipment_id=$1 and not (id=any($2::bigint[]))`,
            [before.shipment.id, trackerIds]
        );
        await client.query(
            `insert into activity_log(type,title,details) values('order',$1,$2)`,
            [`Corrected multi-package tracking for ${ORDER_CODE}`, `${ACCOUNT} | 2 reviewed UPS package tracking numbers`]
        );
        await client.query("commit");
        const afterClient = await pool.connect();
        try {
            const after = await snapshot(afterClient, false);
            if (!verifyExact(after)) throw new Error("Post-correction verification failed.");
            console.log(JSON.stringify({ mode: "apply", corrected: true, after }, null, 2));
        } finally { afterClient.release(); }
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
