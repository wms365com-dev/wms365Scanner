"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const WAREHOUSE = "GW3PL-MISS";
const START = "2026-10-01";
const END = "2026-11-01";
const OUTPUT = path.resolve("outputs/ranchers-october-2026-labels/billing-snapshot.json");

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin transaction read only");
    const [scope, events, rates, orders, allEventStats, profiles, rateCardLines] = await Promise.all([
      db.query(`select si.id integration_id,si.account_name,si.store_identifier,si.is_active,fl.id warehouse_id,fl.code warehouse_code
        from store_integrations si cross join fulfillment_locations fl
        where si.id=4 and si.account_name=$1 and si.store_identifier=$2 and si.provider='SHOPIFY' and si.is_active
          and fl.id=1 and fl.code=$3`, [ACCOUNT, STORE, WAREHOUSE]),
      db.query(`select id,event_key,account_name,fee_category,fee_code,fee_name,unit_label,quantity,rate,amount,
          currency_code,service_date,status,invoice_number,invoiced_at,source_type,source_ref,reference,note,
          warehouse_id,activity_type,charge_type,description,tax_code,created_at,updated_at
        from billing_events where account_name=$1 and service_date >= $2::date and service_date < $3::date
        order by service_date,id`, [ACCOUNT, START, END]),
      db.query(`select r.fee_code,r.rate,r.is_enabled,r.unit_label,r.note,c.category,c.name
        from owner_billing_rates r join billing_fee_catalog c on c.code=r.fee_code
        where r.account_name=$1 order by c.category,r.fee_code`, [ACCOUNT]),
      db.query(`select o.order_code,o.status,o.confirmed_ship_date,o.shipped_at,
          coalesce(sum(l.requested_quantity),0)::numeric requested_quantity
        from portal_orders o left join portal_order_lines l on l.order_id=o.id
        where o.account_name=$1 and o.confirmed_ship_date >= $2::date and o.confirmed_ship_date < $3::date
        group by o.id,o.order_code,o.status,o.confirmed_ship_date,o.shipped_at order by o.confirmed_ship_date,o.order_code`, [ACCOUNT, START, END]),
      db.query(`select count(*)::integer event_count,min(service_date) first_service_date,max(service_date) last_service_date,
          coalesce(sum(amount) filter (where lower(status) not in ('void','voided')),0)::numeric non_void_amount
        from billing_events where account_name=$1`, [ACCOUNT]),
      db.query(`select * from customer_billing_profiles where account_name=$1`, [ACCOUNT]),
      db.query(`select rc.id rate_card_id,rc.name rate_card_name,rc.currency,rc.effective_from,rc.effective_to,rc.is_active,
          l.id line_id,l.charge_type,l.unit,l.rate,l.tax_code,l.customer_id,l.effective_from line_effective_from,
          l.effective_to line_effective_to,l.notes
        from customer_billing_profiles p join rate_cards rc on rc.id=p.assigned_rate_card_id
        join rate_card_lines l on l.rate_card_id=rc.id
        where p.account_name=$1 order by l.charge_type,l.customer_id,l.id`, [ACCOUNT])
    ]);
    if (scope.rowCount !== 1) throw new Error("Pinned Rancher's account, integration, or warehouse identity mismatch.");
    await db.query("rollback");
    const nonVoid = events.rows.filter((r) => !["void","voided"].includes(String(r.status || "").toLowerCase()));
    const output = {
      generatedAt: new Date().toISOString(), mode: "READ_ONLY", account: ACCOUNT, store: STORE,
      integrationId: 4, warehouse: WAREHOUSE, period: { start: START, endExclusive: END },
      events: events.rows, nonVoidEvents: nonVoid, rates: rates.rows, shippedOrders: orders.rows,
      allEventStats: allEventStats.rows[0] || {}, billingProfiles: profiles.rows || [], rateCardLines: rateCardLines.rows || [],
      reconciliation: {
        eventRows: events.rowCount,
        nonVoidRows: nonVoid.length,
        voidRows: events.rowCount - nonVoid.length,
        shippedOrders: orders.rowCount,
        nonVoidAmountByCurrency: nonVoid.reduce((acc, r) => {
          const currency = r.currency_code || "UNSPECIFIED";
          acc[currency] = (acc[currency] || 0) + Number(r.amount || 0);
          return acc;
        }, {})
      }
    };
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ outputPath: OUTPUT, ...output.reconciliation }, null, 2));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
