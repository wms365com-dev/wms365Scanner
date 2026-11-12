const {
    APP_USER_ROLES, decryptStoreIntegrationRow, fetchShopifyOrderFulfillmentsForIntegration,
    updateAdminPortalOrderStatus, exportShopifyInventoryLevels, withTransaction
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const EXPECTED = new Map([["ORD-000780", 18], ["ORD-000815", 6]]);
const APPLY = process.argv.includes("--apply");
const actor = { id: null, email: "k.prathab@gmail.com", full_name: "WMS365 Owner Approved Cancellation", role: APP_USER_ROLES.SUPER_ADMIN };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graphql(integration, query, variables = {}) {
    const response = await fetch(`https://${integration.store_identifier}/admin/api/2026-07/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": integration.access_token },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) throw new Error(JSON.stringify(payload.errors || { status: response.status }));
    return payload.data;
}

async function facts(client, lock = false) {
    const result = await client.query(
        `select o.id order_id,o.order_code,o.account_name,o.po_number,o.status,o.shipped_tracking_reference,
                fl.code warehouse_code,soi.external_order_id,si.*
         from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         join store_order_imports soi on soi.portal_order_id=o.id
         join store_integrations si on si.id=soi.integration_id
         where o.account_name=$1 and o.order_code=any($2::text[])
         order by o.order_code${lock ? " for update of o" : ""}`,
        [ACCOUNT, [...EXPECTED.keys()]]
    );
    if (result.rows.length !== 2 || new Set(result.rows.map((row) => row.order_code)).size !== 2) throw new Error("Expected exactly two unique Rancher's orders with Shopify links.");
    for (const row of result.rows) {
        if (row.account_name !== ACCOUNT || row.warehouse_code !== "GW3PL-MISS" || row.store_identifier !== "f1acxk-dc.myshopify.com") throw new Error(`${row.order_code}: company, warehouse or Shopify store mismatch.`);
        if (!["RELEASED", "CANCELLED"].includes(row.status) || row.shipped_tracking_reference) throw new Error(`${row.order_code}: not an unshipped released/cancelled order.`);
        const lines = await client.query("select sku,requested_quantity from portal_order_lines where order_id=$1", [row.order_id]);
        if (lines.rows.length !== 1 || lines.rows[0].sku !== "RTC-4OZ-EA" || Number(lines.rows[0].requested_quantity) !== EXPECTED.get(row.order_code)) throw new Error(`${row.order_code}: SKU or quantity mismatch.`);
        const allocations = await client.query(
            `select coalesce(sum(a.allocated_quantity),0)::integer quantity,
                    count(*) filter(where i.account_name<>$2 or i.sku<>'RTC-4OZ-EA' or i.id is null)::integer bad
             from portal_order_allocations a left join inventory_lines i on i.id=a.inventory_line_id where a.order_id=$1`,
            [row.order_id, ACCOUNT]
        );
        if (allocations.rows[0].bad) throw new Error(`${row.order_code}: invalid inventory ownership.`);
        row.reserved_quantity = Number(allocations.rows[0].quantity);
    }
    return result.rows;
}

async function main() {
    if (APPLY && process.env.CONFIRM_RANCHERS_CANCEL !== "APPROVED_780_815") throw new Error("Explicit cancellation confirmation required.");
    const rows = await withTransaction(async (client) => { await client.query("set transaction read only"); return facts(client); });
    const remotes = [];
    for (const row of rows) {
        const remote = await fetchShopifyOrderFulfillmentsForIntegration(decryptStoreIntegrationRow(row), row.external_order_id);
        const integration = remote.integrationRow;
        const id = `gid://shopify/Order/${row.external_order_id}`;
        const data = await graphql(integration,
            `query($id:ID!){order(id:$id){id name cancelledAt displayFinancialStatus displayFulfillmentStatus} currentAppInstallation{accessScopes{handle}}}`, { id });
        if (!data.order || data.order.name !== row.po_number) throw new Error(`${row.order_code}: Shopify order reference mismatch.`);
        if (!data.order.cancelledAt && remote.fulfillments.some((entry) => !["cancelled", "failure", "error"].includes(String(entry.status).toLowerCase()))) throw new Error(`${row.order_code}: active Shopify fulfillment needs review.`);
        const scopes = data.currentAppInstallation.accessScopes.map((scope) => scope.handle);
        remotes.push({ row, integration, order: data.order, canCancel: scopes.includes("write_orders") });
        console.log(JSON.stringify({ order: row.order_code, shopifyOrder: data.order.name, wmsStatus: row.status,
            reservedUnits: row.reserved_quantity, shopifyCancelledAt: data.order.cancelledAt,
            paymentStatus: data.order.displayFinancialStatus, fulfillmentStatus: data.order.displayFulfillmentStatus,
            hasCancellationPermission: scopes.includes("write_orders") }));
    }
    if (!APPLY) return;
    const cancellations = await withTransaction(async (client) => {
        const locked = await facts(client, true);
        const results = [];
        for (const row of locked) {
            if (row.status !== "CANCELLED") await updateAdminPortalOrderStatus(client, row.order_id, "CANCELLED", {
                cancelReason: "Owner requested cancellation; do not ship. Shopify cancellation requested separately, no payment refund authorized.",
                idempotencyKey: `owner-ranchers-cancel-20260916-${row.order_id}`
            }, actor);
            const check = await client.query("select count(*)::integer count from portal_order_allocations where order_id=$1", [row.order_id]);
            if (check.rows[0].count) throw new Error(`${row.order_code}: allocations were not released.`);
            results.push({ order: row.order_code, wmsStatus: "CANCELLED", releasedUnits: row.reserved_quantity });
        }
        return results;
    });
    console.log(JSON.stringify({ wmsCancellations: cancellations }));
    for (const entry of remotes) {
        try {
            if (!entry.order.cancelledAt) {
                if (!entry.canCancel) { console.log(JSON.stringify({ order: entry.row.order_code, shopifyStatus: "BLOCKED", reason: "Shopify app is missing write_orders permission." })); continue; }
                const data = await graphql(entry.integration,
                    `mutation($id:ID!){orderCancel(orderId:$id,reason:OTHER,refund:false,restock:true,notifyCustomer:true,staffNote:"Cancelled by Grey Wolf at account owner's request. No refund authorized."){job{id done} orderCancelUserErrors{field message code}}}`,
                    { id: entry.order.id });
                if (data.orderCancel.orderCancelUserErrors.length) throw new Error(JSON.stringify(data.orderCancel.orderCancelUserErrors));
            }
            let verified;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                const data = await graphql(entry.integration, "query($id:ID!){order(id:$id){name cancelledAt displayFinancialStatus}}", { id: entry.order.id });
                verified = data.order;
                if (verified.cancelledAt) break;
                await sleep(1500);
            }
            if (!verified?.cancelledAt) throw new Error("Shopify cancellation not confirmed; do not resubmit until checked.");
            console.log(JSON.stringify({ order: entry.row.order_code, shopifyStatus: "CANCELLED", cancelledAt: verified.cancelledAt, paymentStatus: verified.displayFinancialStatus }));
        } catch (error) { console.log(JSON.stringify({ order: entry.row.order_code, shopifyStatus: "FAILED", reason: error.message })); }
    }
    const integrations = [...new Map(remotes.map((entry) => [entry.integration.id, entry.integration])).values()];
    for (const integration of integrations) {
        const inventory = await withTransaction((client) => exportShopifyInventoryLevels(client, integration));
        console.log(JSON.stringify({ shopifyInventory: inventory }));
    }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
