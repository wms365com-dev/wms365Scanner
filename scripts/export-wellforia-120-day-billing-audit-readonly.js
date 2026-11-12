"use strict";

const zlib = require("node:zlib");
const { Client } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const START = String(process.argv[2] || "2026-07-08").trim();
const END_EXCLUSIVE = String(process.argv[3] || "2026-11-05").trim();

if (!/^\d{4}-\d{2}-\d{2}$/.test(START) || !/^\d{4}-\d{2}-\d{2}$/.test(END_EXCLUSIVE)) {
    throw new Error("Usage: node scripts/export-wellforia-120-day-billing-audit-readonly.js YYYY-MM-DD YYYY-MM-DD");
}

async function main() {
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await db.connect();
    try {
        await db.query("begin transaction read only");
        const [company, orders, events, rates, profiles, rateCardLines, pendingOrders] = await Promise.all([
            db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            db.query(`
                select o.id,o.order_code,o.status,o.po_number,o.order_type,o.shipment_method,
                       coalesce(o.confirmed_ship_date,(o.shipped_at at time zone 'America/Toronto')::date) service_date,
                       o.shipped_carrier_name,o.shipped_tracking_reference,o.outbound_total_pallets,
                       count(l.id)::integer line_count,
                       coalesce(sum(l.requested_quantity),0)::numeric requested_quantity,
                       coalesce(sum(sl.shipped_quantity),0)::numeric shipped_quantity
                  from portal_orders o
                  join portal_order_lines l on l.order_id=o.id
                  left join portal_order_shipment_lines sl on sl.order_id=o.id and sl.order_line_id=l.id
                 where o.account_name=$1 and o.status='SHIPPED'
                   and coalesce(o.confirmed_ship_date,(o.shipped_at at time zone 'America/Toronto')::date)>=$2::date
                   and coalesce(o.confirmed_ship_date,(o.shipped_at at time zone 'America/Toronto')::date)<$3::date
                 group by o.id
                 order by service_date,o.order_code`,
                [ACCOUNT, START, END_EXCLUSIVE]
            ),
            db.query(`
                select id,event_key,fee_category,fee_code,fee_name,unit_label,quantity,rate,amount,
                       currency_code,service_date,status,invoice_number,invoiced_at,source_type,source_ref,
                       source_module,source_reference,activity_type,charge_type,description,reference,note,
                       created_at,updated_at
                  from billing_events
                 where account_name=$1
                   and coalesce(activity_date,service_date)>=$2::date
                   and coalesce(activity_date,service_date)<$3::date
                 order by coalesce(activity_date,service_date),id`,
                [ACCOUNT, START, END_EXCLUSIVE]
            ),
            db.query(`
                select r.fee_code,r.rate,r.is_enabled,r.unit_label,r.note,c.category,c.name
                  from owner_billing_rates r
                  join billing_fee_catalog c on c.code=r.fee_code
                 where r.account_name=$1
                 order by c.category,r.fee_code`, [ACCOUNT]
            ),
            db.query("select * from customer_billing_profiles where account_name=$1", [ACCOUNT]),
            db.query(`
                select rc.id rate_card_id,rc.name rate_card_name,rc.currency,rc.effective_from,rc.effective_to,rc.is_active,
                       l.id line_id,l.charge_type,l.unit,l.rate,l.tax_code,l.customer_id,
                       l.effective_from line_effective_from,l.effective_to line_effective_to,l.notes
                  from customer_billing_profiles p
                  join rate_cards rc on rc.id=p.assigned_rate_card_id
                  join rate_card_lines l on l.rate_card_id=rc.id
                 where p.account_name=$1
                 order by l.charge_type,l.customer_id,l.id`, [ACCOUNT]
            ),
            db.query(`
                select o.order_code,o.status,o.requested_ship_date,o.created_at,
                       count(l.id)::integer line_count,coalesce(sum(l.requested_quantity),0)::numeric requested_quantity
                  from portal_orders o join portal_order_lines l on l.order_id=o.id
                 where o.account_name=$1 and o.status<>'SHIPPED' and o.status not in ('CANCELLED','ARCHIVED')
                   and o.created_at >= $2::date and o.created_at < $3::date
                 group by o.id order by o.created_at,o.order_code`,
                [ACCOUNT, START, END_EXCLUSIVE]
            )
        ]);

        if (company.rowCount !== 1 || company.rows[0].name !== ACCOUNT || company.rows[0].is_active !== true) {
            throw new Error("Exact active Wellforia tenant verification failed.");
        }

        const eventsByOrder = new Map();
        for (const event of events.rows) {
            const refs = [event.source_ref, event.source_reference].map((value) => String(value || "").trim()).filter(Boolean);
            for (const ref of refs) {
                if (!eventsByOrder.has(ref)) eventsByOrder.set(ref, []);
                if (!eventsByOrder.get(ref).some((row) => row.id === event.id)) eventsByOrder.get(ref).push(event);
            }
        }

        const reconciledOrders = orders.rows.map((order) => {
            const matched = eventsByOrder.get(order.order_code) || [];
            const nonVoid = matched.filter((event) => !["void", "voided"].includes(String(event.status || "").toLowerCase()));
            return {
                ...order,
                billing_status: nonVoid.length ? "MATCHED" : (matched.length ? "VOID_ONLY" : "MISSING"),
                billing_event_count: matched.length,
                non_void_event_count: nonVoid.length,
                billing_amount: nonVoid.reduce((sum, event) => sum + Number(event.amount || 0), 0),
                billing_currencies: [...new Set(nonVoid.map((event) => event.currency_code).filter(Boolean))].join(", "),
                billing_event_ids: matched.map((event) => event.id)
            };
        });

        const matchedEventIds = new Set(reconciledOrders.flatMap((order) => order.billing_event_ids));
        const unmatchedEvents = events.rows.filter((event) => !matchedEventIds.has(event.id));
        const report = {
            generatedAt: new Date().toISOString(),
            mode: "READ_ONLY",
            account: ACCOUNT,
            period: { start: START, endExclusive: END_EXCLUSIVE, days: 120 },
            reconciliation: {
                shippedOrders: reconciledOrders.length,
                matchedOrders: reconciledOrders.filter((row) => row.billing_status === "MATCHED").length,
                missingOrders: reconciledOrders.filter((row) => row.billing_status === "MISSING").length,
                voidOnlyOrders: reconciledOrders.filter((row) => row.billing_status === "VOID_ONLY").length,
                billedAmount: reconciledOrders.reduce((sum, row) => sum + Number(row.billing_amount || 0), 0),
                billingEvents: events.rowCount,
                unmatchedBillingEvents: unmatchedEvents.length,
                openUnshippedOrders: pendingOrders.rowCount
            },
            orders: reconciledOrders,
            billingEvents: events.rows,
            unmatchedBillingEvents: unmatchedEvents,
            ownerBillingRates: rates.rows,
            billingProfiles: profiles.rows,
            rateCardLines: rateCardLines.rows,
            openUnshippedOrders: pendingOrders.rows
        };
        await db.query("rollback");
        console.log(JSON.stringify({
            ...report.reconciliation,
            reportGzipBase64: zlib.gzipSync(Buffer.from(JSON.stringify(report))).toString("base64")
        }));
    } finally {
        await db.end();
    }
}

if (require.main === module) main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});

module.exports = { main };
