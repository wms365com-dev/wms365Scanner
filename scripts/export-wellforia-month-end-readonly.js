const zlib = require("node:zlib");
const { Client } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const month = String(process.argv[2] || "2026-09").trim();
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Usage: node scripts/export-wellforia-month-end-readonly.js YYYY-MM");
const start = `${month}-01`;
const endDate = new Date(`${start}T12:00:00Z`);
endDate.setUTCMonth(endDate.getUTCMonth() + 1);
const end = endDate.toISOString().slice(0, 10);

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const params = [ACCOUNT, start, end];
        const [company, outbound, inbound, inventory, billing, endingInventory] = await Promise.all([
            client.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            client.query(`select o.order_code,o.status,o.po_number,o.order_type,o.shipment_method,o.confirmed_ship_date,o.shipped_at,o.shipped_carrier_name,o.outbound_total_pallets,l.line_number,l.sku,l.requested_quantity,coalesce(sl.shipped_quantity,0) shipped_quantity from portal_orders o join portal_order_lines l on l.order_id=o.id left join portal_order_shipment_lines sl on sl.order_id=o.id and sl.order_line_id=l.id where o.account_name=$1 and coalesce(o.confirmed_ship_date,(o.shipped_at at time zone 'America/Toronto')::date)>=$2::date and coalesce(o.confirmed_ship_date,(o.shipped_at at time zone 'America/Toronto')::date)<$3::date and o.status='SHIPPED' order by coalesce(o.confirmed_ship_date,(o.shipped_at at time zone 'America/Toronto')::date),o.order_code,l.line_number`, params),
            client.query(`select i.inbound_code,i.status,i.reference_number,i.carrier_name,(i.received_at at time zone 'America/Toronto')::date received_date,l.line_number,l.sku,l.expected_quantity,coalesce(l.received_quantity,0) received_quantity,l.received_location,l.lot_number,l.expiration_date from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id where i.account_name=$1 and (i.received_at at time zone 'America/Toronto')::date>=$2::date and (i.received_at at time zone 'America/Toronto')::date<$3::date and i.status<>'CANCELLED' order by received_date,i.inbound_code,l.line_number`, params),
            client.query(`select (t.server_timestamp at time zone 'America/Toronto') activity_time,t.transaction_type,t.source_type,t.source_id,t.location,t.sku,t.lot_number,t.expiration_date,t.quantity_delta,t.quantity_before,t.quantity_after from inventory_transactions t where t.account_name=$1 and (t.server_timestamp at time zone 'America/Toronto')::date>=$2::date and (t.server_timestamp at time zone 'America/Toronto')::date<$3::date order by t.server_timestamp,t.id`, params),
            client.query(`select service_date,fee_category,fee_code,fee_name,unit_label,quantity,rate,amount,currency_code,status,source_type,source_ref,reference,note from billing_events where account_name=$1 and service_date>=$2::date and service_date<$3::date and lower(status) not in ('void','voided') order by service_date,id`, params),
            client.query("select sku,tracking_level,location,lot_number,expiration_date,quantity from inventory_lines where account_name=$1 and quantity>0 order by sku,location,lot_number,expiration_date", [ACCOUNT])
        ]);
        if (company.rowCount !== 1 || company.rows[0].name !== ACCOUNT || company.rows[0].is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");
        const report = { account: ACCOUNT, period: { key: month, start, end }, generatedAt: new Date().toISOString(), outbound: outbound.rows, inbound: inbound.rows, inventoryActivity: inventory.rows, billing: billing.rows, currentInventoryReference: endingInventory.rows };
        console.log(JSON.stringify({ period: month, outboundLines: report.outbound.length, inboundLines: report.inbound.length, inventoryTransactions: report.inventoryActivity.length, billingLines: report.billing.length, reportGzipBase64: zlib.gzipSync(Buffer.from(JSON.stringify(report))).toString("base64") }));
        await client.query("rollback");
    } finally { await client.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
module.exports = { main };
