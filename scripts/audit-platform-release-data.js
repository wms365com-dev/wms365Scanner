const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const testCompanyResult = await client.query(
            `select name from owner_accounts
             where upper(name) like '%TEST%COMPANY%' or upper(name) = 'WMS365 TEST COMPANY'
             order by case when upper(name) = 'WMS365 TEST COMPANY' then 0 else 1 end, name
             limit 1`
        );
        const testCompany = testCompanyResult.rows[0]?.name || "";
        if (!testCompany) throw new Error("No WMS365 test company is configured.");
        const [warehouseAccess, records, schema, billing] = await Promise.all([
            client.query(
                `select count(*)::integer as warehouses
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id and fl.is_active = true
                 where cfl.account_name = $1`,
                [testCompany]
            ),
            client.query(
                `select
                    (select count(*) from portal_orders where account_name = $1)::integer as orders,
                    (select count(*) from portal_inbounds where account_name = $1)::integer as inbounds,
                    (select count(*) from warehouse_shipments where account_name = $1)::integer as shipments,
                    (select count(*) from warehouse_tasks where account_name = $1)::integer as tasks,
                    (select count(*) from inventory_transactions where account_name = $1)::integer as ledger_entries`,
                [testCompany]
            ),
            client.query(
                `select
                    to_regclass('public.inventory_transactions') is not null as ledger,
                    to_regclass('public.warehouse_shipments') is not null as shipments,
                    to_regclass('public.async_jobs') is not null as jobs,
                    to_regclass('public.partner_api_approvals') is not null as approvals,
                    to_regclass('public.storage_billing_snapshots') is not null as storage_snapshots,
                    exists (select 1 from information_schema.columns where table_schema='public' and table_name='inventory_transactions' and column_name='idempotency_key') as ledger_idempotency`
            ),
            client.query(
                `with completed as (
                    select account_name, coalesce(nullif(inbound_code,''), 'INBOUND-' || id::text) source_ref, 'INBOUND_RECEIPT' source_type
                    from portal_inbounds where status in ('RECEIVED','RECEIVED_PENDING_PUTAWAY','PARTIALLY_PUTAWAY','PUTAWAY_COMPLETE') and received_at::date >= date '2026-07-31'
                    union all
                    select account_name, coalesce(nullif(order_code,''), 'ORDER-' || id::text), 'OUTBOUND_ORDER'
                    from portal_orders where status='SHIPPED' and confirmed_ship_date >= date '2026-07-31'
                 )
                 select count(*)::integer completed,
                        count(*) filter (where exists (select 1 from billing_events b where b.account_name=completed.account_name and b.source_ref=completed.source_ref and b.source_type=completed.source_type and b.status <> 'VOID'))::integer matched,
                        count(*) filter (where not exists (select 1 from billing_events b where b.account_name=completed.account_name and b.source_ref=completed.source_ref and b.source_type=completed.source_type and b.status <> 'VOID')
                            and exists (select 1 from owner_billing_rates r where r.account_name=completed.account_name and r.is_enabled=true))::integer actionable_missing,
                        coalesce(jsonb_agg(jsonb_build_object('accountName', account_name, 'sourceRef', source_ref, 'sourceType', source_type))
                            filter (where not exists (select 1 from billing_events b where b.account_name=completed.account_name and b.source_ref=completed.source_ref and b.source_type=completed.source_type and b.status <> 'VOID')
                                and exists (select 1 from owner_billing_rates r where r.account_name=completed.account_name and r.is_enabled=true)), '[]'::jsonb) as missing
                 from completed`
            )
        ]);
        const checks = schema.rows[0];
        const failedSchema = Object.entries(checks).filter(([, value]) => value !== true);
        if (failedSchema.length) throw new Error(`Production schema missing: ${failedSchema.map(([key]) => key).join(", ")}`);
        console.log(JSON.stringify({
            testCompany,
            warehouses: Number(warehouseAccess.rows[0]?.warehouses) || 0,
            records: records.rows[0],
            schema: checks,
            billingEmailEnabled: String(process.env.WAREHOUSE_BILLING_EMAIL_ENABLED || "false").toLowerCase() === "true",
            billingSinceCutover: billing.rows[0]
        }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
