"use strict";

const assert = require("node:assert/strict");
const { Client } = require("pg");
const { createShopifyTrackingApi } = require("../shopify-tracking-api");
const { normalizeTrackingCarrier } = require("../carrier-tracking");
const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const INTEGRATION_ID = 4;
const WAREHOUSE_ID = "1";
const SUPPORTED = new Set(["CANPAR", "ICS_COURIER", "GLS"]);
const QUERY = `query ReadOnlyDeliveryAudit($id: ID!) {
    shop { id myshopifyDomain }
    order(id:$id) { id fulfillmentsCount { count } fulfillments(first:100) {
        id status displayStatus deliveredAt trackingInfo { company number }
    } }
}`;

function verifyScope(integration, orders) {
    assert.equal(Number(integration?.id), INTEGRATION_ID, "INTEGRATION_SCOPE_MISMATCH");
    assert.equal(integration.account_name, ACCOUNT, "ACCOUNT_SCOPE_MISMATCH");
    assert.equal(integration.store_identifier, STORE, "STORE_SCOPE_MISMATCH");
    assert.equal(integration.provider, "SHOPIFY", "PROVIDER_SCOPE_MISMATCH");
    assert.equal(integration.is_active, true, "INTEGRATION_INACTIVE");
    for (const order of orders) {
        assert.equal(order.account_name, ACCOUNT, "ORDER_ACCOUNT_MISMATCH");
        assert.equal(String(order.fulfillment_location_id), WAREHOUSE_ID, "ORDER_WAREHOUSE_MISMATCH");
        assert.match(String(order.order_code), /^ORD-\d{6}$/, "ORDER_CODE_INVALID");
        assert.match(String(order.external_order_id), /^(?:gid:\/\/shopify\/Order\/)?\d+$/, "ORDER_LINK_INVALID");
    }
}

function classify(order, remote, trackers, bindings, packages) {
    const expectedId = `gid://shopify/Order/${String(order.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "")}`;
    if (remote?.shop?.myshopifyDomain !== STORE || remote.order?.id !== expectedId) throw Error("REMOTE_OWNERSHIP_MISMATCH");
    const fulfillments = remote.order.fulfillments;
    if (!Array.isArray(fulfillments) || !Number.isInteger(remote.order.fulfillmentsCount?.count)
        || remote.order.fulfillmentsCount.count !== fulfillments.length) throw Error("REMOTE_FULFILLMENTS_INCOMPLETE");
    const result = { order: order.order_code, fulfillments: [] };
    if (!fulfillments.length) result.issue = "SHIPPED_ORDER_WITHOUT_SHOPIFY_FULFILLMENT";
    const seen = new Set();
    for (const fulfillment of fulfillments) {
        if (!/^gid:\/\/shopify\/Fulfillment\/\d+$/.test(fulfillment.id) || seen.has(fulfillment.id)) throw Error("REMOTE_FULFILLMENT_ID_INVALID");
        seen.add(fulfillment.id);
        const entry = { fulfillment: fulfillment.id, shopifyStatus: fulfillment.displayStatus,
            shopifyDelivered: fulfillment.displayStatus === "DELIVERED" || Boolean(fulfillment.deliveredAt), issues: [] };
        result.fulfillments.push(entry);
        if (["CANCELLED", "FAILURE"].includes(fulfillment.status)) {
            entry.skipped = fulfillment.status;
            continue;
        }
        const numbers = fulfillment.trackingInfo?.map(item => item.number) || [];
        if (!numbers.length || numbers.some(number => typeof number !== "string" || !number.trim()) || new Set(numbers).size !== numbers.length) {
            entry.issues.push("REMOTE_PACKAGE_IDENTITY_INCOMPLETE");
            continue;
        }
        const carriers = fulfillment.trackingInfo.map(item => normalizeTrackingCarrier(item.company));
        if (carriers.some(carrier => !SUPPORTED.has(carrier))) entry.issues.push("UNSUPPORTED_CARRIER");
        const matches = bindings.filter(binding => binding.fulfillment_gid === fulfillment.id);
        const binding = matches.length === 1 ? matches[0] : null;
        if (!binding) entry.issues.push("MISSING_OR_AMBIGUOUS_BINDING");
        else if (binding.external_order_id.replace(/^gid:\/\/shopify\/Order\//, "") !== String(order.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "")) entry.issues.push("BINDING_ORDER_ID_MISMATCH");
        if (binding && (!Array.isArray(binding.expected_tracking_numbers) || binding.expected_tracking_numbers.length !== numbers.length
            || numbers.some(number => !binding.expected_tracking_numbers.includes(number)))) entry.issues.push("BINDING_PACKAGE_IDENTITY_MISMATCH");
        const matchedTrackers = numbers.map((number, index) => {
            const candidates = trackers.filter(tracker => tracker.tracking_number === number);
            if (candidates.length !== 1) { entry.issues.push("MISSING_OR_AMBIGUOUS_WMS_TRACKER"); return null; }
            const tracker = candidates[0];
            if (normalizeTrackingCarrier(tracker.carrier_name) !== carriers[index]) entry.issues.push("CARRIER_IDENTITY_MISMATCH");
            if (binding) {
                const matchedPackages = packages.filter(item => String(item.fulfillment_binding_id) === String(binding.id)
                    && String(item.tracker_id) === String(tracker.id) && item.tracking_number === number);
                if (matchedPackages.length !== 1) entry.issues.push("MISSING_OR_AMBIGUOUS_PACKAGE_BINDING");
            }
            return tracker;
        });
        entry.packageCount = numbers.length;
        entry.wmsStatuses = matchedTrackers.map(tracker => tracker?.status || "UNBOUND");
        entry.deliveryEvidence = matchedTrackers.map(tracker => !tracker ? "UNBOUND"
            : tracker.has_carrier_delivery_evidence ? "CARRIER_CONFIRMED"
            : tracker.has_owner_delivery_confirmation ? "OWNER_CONFIRMED" : "NO_DELIVERY_EVIDENCE");
        entry.wmsAllDelivered = matchedTrackers.every(tracker => tracker?.status === "DELIVERED");
        if (matchedTrackers.some(tracker => tracker?.status === "DELIVERED"
            && !tracker.has_carrier_delivery_evidence && !tracker.has_owner_delivery_confirmation)) entry.issues.push("WMS_DELIVERED_EVIDENCE_MISSING");
        if (entry.wmsAllDelivered && !entry.shopifyDelivered) entry.issues.push("WMS_DELIVERED_SHOPIFY_NOT_DELIVERED");
        if (entry.shopifyDelivered && !entry.wmsAllDelivered) entry.issues.push("SHOPIFY_DELIVERED_WMS_NOT_ALL_DELIVERED");
        entry.issues = [...new Set(entry.issues)];
    }
    for (const binding of bindings) if (!seen.has(binding.fulfillment_gid)) {
        result.fulfillments.push({ fulfillment: binding.fulfillment_gid, issues: ["BINDING_NOT_PRESENT_IN_REMOTE_ORDER"] });
    }
    return result;
}

async function runAudit(client, api, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    let integration, orders, trackers, bindings, packages, statusCounts;
    await client.query("begin read only");
    try {
        await client.query("set local statement_timeout='60s'");
        integration = (await client.query("select * from store_integrations where id=$1 and account_name=$2 and store_identifier=$3", [INTEGRATION_ID, ACCOUNT, STORE])).rows[0];
        orders = (await client.query(`select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,imp.external_order_id
            from portal_orders o join store_order_imports imp on imp.portal_order_id=o.id and imp.integration_id=$1
            join store_integrations i on i.id=imp.integration_id and i.account_name=o.account_name and i.store_identifier=$3
            where o.account_name=$2 and o.fulfillment_location_id=$4 and o.status='SHIPPED'
            order by o.id`, [INTEGRATION_ID, ACCOUNT, STORE, WAREHOUSE_ID])).rows;
        statusCounts = (await client.query(`select o.status,count(distinct o.id)::int as count from portal_orders o
            join store_order_imports imp on imp.portal_order_id=o.id and imp.integration_id=$1
            join store_integrations i on i.id=imp.integration_id and i.account_name=o.account_name and i.store_identifier=$3
            where o.account_name=$2 and o.fulfillment_location_id=$4 group by o.status`, [INTEGRATION_ID, ACCOUNT, STORE, WAREHOUSE_ID])).rows;
        verifyScope(integration, orders);
        if (new Set(orders.map(order => String(order.id))).size !== orders.length) throw Error("DUPLICATE_ORDER_IMPORT_LINK");
        const ids = orders.map(order => order.id);
        trackers = (await client.query(`select t.id,t.order_id,t.tracking_number,t.carrier_name,t.status,
            exists(select 1 from shipment_tracking_events e where e.tracker_id=t.id and e.status='DELIVERED'
                and e.source=any(array['AFTERSHIP','CANPAR_BROWSER','ICS_COURIER_BROWSER','GLS_BROWSER'])
                and e.safe_metadata->>'carrier_scan'='true') as has_carrier_delivery_evidence,
            exists(select 1 from shipment_tracking_events e where e.tracker_id=t.id and e.status='DELIVERED'
                and e.source='OWNER_CONFIRMATION' and e.safe_metadata->>'owner_confirmed'='true') as has_owner_delivery_confirmation
            from shipment_trackers t join warehouse_shipments s on s.id=t.warehouse_shipment_id
              and s.order_id=t.order_id and s.account_name=t.account_name and s.fulfillment_location_id=t.fulfillment_location_id
            join portal_orders o on o.id=t.order_id and o.account_name=t.account_name and o.fulfillment_location_id=t.fulfillment_location_id
            where o.id=any($1::bigint[]) and t.account_name=$2 and t.fulfillment_location_id=$3 and s.status='SHIPPED'`, [ids, ACCOUNT, WAREHOUSE_ID])).rows;
        bindings = (await client.query(`select f.id,f.order_id,f.fulfillment_gid,f.external_order_id,f.expected_tracking_numbers
            from shopify_tracking_fulfillments f join portal_orders o on o.id=f.order_id and o.account_name=f.account_name
            join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name and i.store_identifier=f.store_identifier
            where f.integration_id=$1 and f.account_name=$2 and f.store_identifier=$3 and o.fulfillment_location_id=$4
              and o.id=any($5::bigint[])`, [INTEGRATION_ID, ACCOUNT, STORE, WAREHOUSE_ID, ids])).rows;
        packages = (await client.query(`select p.fulfillment_binding_id,p.order_id,p.tracker_id,p.tracking_number
            from shopify_tracking_packages p join shopify_tracking_fulfillments f on f.id=p.fulfillment_binding_id and f.account_name=p.account_name and f.order_id=p.order_id
            join shipment_trackers t on t.id=p.tracker_id and t.account_name=p.account_name and t.order_id=p.order_id
              and t.fulfillment_location_id=p.fulfillment_location_id and t.warehouse_shipment_id=p.warehouse_shipment_id
            join warehouse_shipments s on s.id=t.warehouse_shipment_id and s.account_name=t.account_name and s.order_id=t.order_id and s.fulfillment_location_id=t.fulfillment_location_id
            join portal_orders o on o.id=f.order_id and o.account_name=f.account_name and o.fulfillment_location_id=p.fulfillment_location_id
            join store_integrations i on i.id=f.integration_id and i.account_name=f.account_name and i.store_identifier=f.store_identifier
            where f.integration_id=$1 and f.account_name=$2 and f.store_identifier=$3 and p.fulfillment_location_id=$4
              and o.id=any($5::bigint[]) and s.status='SHIPPED'`, [INTEGRATION_ID, ACCOUNT, STORE, WAREHOUSE_ID, ids])).rows;
    } finally { await client.query("rollback"); }
    await api.verify(integration);
    const report = { checkedAt: new Date().toISOString(), integrationId: INTEGRATION_ID, warehouseId: Number(WAREHOUSE_ID),
        readOnly: true, wmsOrderStatusCounts: statusCounts, ordersSelected: orders.length, ordersChecked: 0,
        fulfillmentCount: 0, shopifyStatusCounts: {}, deliveryEvidenceCounts: {}, issueCounts: {}, mismatchOrders: [], records: [] };
    for (const order of orders) {
        let record;
        try {
            const id = `gid://shopify/Order/${String(order.external_order_id).replace(/^gid:\/\/shopify\/Order\//, "")}`;
            const remote = await api.request(integration, "/graphql.json", { body: { query: QUERY, variables: { id } } });
            record = classify(order, remote.payload.data, trackers.filter(row => String(row.order_id) === String(order.id)),
                bindings.filter(row => String(row.order_id) === String(order.id)), packages.filter(row => String(row.order_id) === String(order.id)));
            report.ordersChecked += 1;
        } catch (error) {
            const allowed = new Set(["REMOTE_OWNERSHIP_MISMATCH", "REMOTE_FULFILLMENTS_INCOMPLETE", "REMOTE_FULFILLMENT_ID_INVALID"]);
            record = { order: order.order_code, issue: allowed.has(error.message) ? error.message : "SHOPIFY_READ_FAILED", fulfillments: [] };
        }
        const issues = new Set(record.issue ? [record.issue] : []);
        for (const fulfillment of record.fulfillments) {
            report.fulfillmentCount += 1;
            const status = fulfillment.skipped || fulfillment.shopifyStatus || "UNKNOWN";
            report.shopifyStatusCounts[status] = (report.shopifyStatusCounts[status] || 0) + 1;
            for (const evidence of fulfillment.deliveryEvidence || []) report.deliveryEvidenceCounts[evidence] = (report.deliveryEvidenceCounts[evidence] || 0) + 1;
            for (const issue of fulfillment.issues) issues.add(issue);
        }
        for (const issue of issues) report.issueCounts[issue] = (report.issueCounts[issue] || 0) + 1;
        if (issues.size) report.mismatchOrders.push({ order: order.order_code, issues: [...issues] });
        report.records.push(record);
        if (report.records.length % 50 === 0) console.error(JSON.stringify({ auditProgress: report.records.length, total: orders.length }));
        await wait(350);
    }
    return report;
}

function selfTest() {
    const integration = { id: 4, account_name: ACCOUNT, store_identifier: STORE, provider: "SHOPIFY", is_active: true };
    const order = { id: "10", order_code: "ORD-000010", account_name: ACCOUNT, fulfillment_location_id: "1", external_order_id: "10" };
    verifyScope(integration, [order]);
    assert.throws(() => verifyScope(integration, [{ ...order, account_name: "FOREIGN" }]));
    assert.throws(() => verifyScope(integration, [{ ...order, fulfillment_location_id: "2" }]));
    assert.throws(() => verifyScope({ ...integration, store_identifier: "other.myshopify.com" }, [order]));
    const remote = { shop: { myshopifyDomain: STORE }, order: { id: "gid://shopify/Order/10", fulfillmentsCount: { count: 1 },
        fulfillments: [{ id: "gid://shopify/Fulfillment/20", status: "SUCCESS", displayStatus: "IN_TRANSIT", trackingInfo: [{ number: "ABC", company: "Canpar" }] }] } };
    const tracker = { id: "30", tracking_number: "ABC", carrier_name: "Canpar", status: "DELIVERED", has_carrier_delivery_evidence: true };
    const binding = { id: "40", fulfillment_gid: "gid://shopify/Fulfillment/20", external_order_id: "10", expected_tracking_numbers: ["ABC"] };
    const pack = { fulfillment_binding_id: "40", tracker_id: "30", tracking_number: "ABC" };
    const full = classify(order, remote, [tracker], [binding], [pack]);
    assert.deepEqual(full.fulfillments[0].issues, ["WMS_DELIVERED_SHOPIFY_NOT_DELIVERED"]);
    assert(classify(order, remote, [tracker], [], []).fulfillments[0].issues.includes("MISSING_OR_AMBIGUOUS_BINDING"));
    assert(classify(order, remote, [], [binding], []).fulfillments[0].issues.includes("MISSING_OR_AMBIGUOUS_WMS_TRACKER"));
    assert(classify(order, remote, [{ ...tracker, has_carrier_delivery_evidence: false }], [binding], [pack]).fulfillments[0].issues.includes("WMS_DELIVERED_EVIDENCE_MISSING"));
    assert.throws(() => classify(order, { ...remote, shop: { myshopifyDomain: "foreign.myshopify.com" } }, [], [], []));
    remote.order.fulfillmentsCount.count = 2;
    assert.throws(() => classify(order, remote, [], [], []));
    return { selfTest: "PASS", checks: 10 };
}

async function main() {
    if (process.argv.includes("--self-test")) { console.log(JSON.stringify(selfTest())); return; }
    if (!process.env.DATABASE_URL) throw Error("DATABASE_REQUIRED");
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 20000,
        options: "-c search_path=wms365_tracking_4,public,pg_catalog" });
    await client.connect();
    try { const report = await runAudit(client, createShopifyTrackingApi()); console.log(JSON.stringify(report)); return report; }
    finally { await client.end(); }
}

module.exports = { main, runAudit, classify, verifyScope, selfTest };
if (require.main === module) main().catch(() => { console.error("READ_ONLY_AUDIT_FAILED"); process.exitCode = 1; });
