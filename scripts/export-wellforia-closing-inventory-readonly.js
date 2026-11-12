const zlib = require("node:zlib");
const { Client } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const cutoff = String(process.argv[2] || "2026-10-01").trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error("Usage: node scripts/export-wellforia-closing-inventory-readonly.js YYYY-MM-DD");

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin read only");
    const company = await db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
    if (company.rowCount !== 1 || company.rows[0].is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");

    const catalog = await db.query(`
      select sku,description,coalesce(nullif(unit_uom,''),nullif(uom_label,''),'CASE') uom
      from item_catalog where account_name=$1 order by sku`, [ACCOUNT]);
    const closingByLocation = await db.query(`
      with current_stock as (
        select sku,location,lot_number,expiration_date,sum(quantity)::numeric quantity
        from inventory_lines where account_name=$1 group by sku,location,lot_number,expiration_date
      ), post_cutoff as (
        select t.sku,t.location,t.lot_number,t.expiration_date,sum(t.quantity_delta)::numeric quantity_delta
        from inventory_transactions t
        where t.account_name=$1
          and t.server_timestamp >= ($2::date::timestamp at time zone 'America/Toronto')
          and not (
            t.transaction_type='SHIPPING'
            and t.source_type='PORTAL_ORDER'
            and exists (
              select 1
              from portal_orders o
              where o.account_name=t.account_name
                and o.id::text=t.source_id
                and coalesce(
                  o.confirmed_ship_date,
                  (o.shipped_at at time zone 'America/Toronto')::date
                ) < $2::date
            )
          )
        group by t.sku,t.location,t.lot_number,t.expiration_date
      ), keys as (
        select sku,location,lot_number,expiration_date from current_stock
        union
        select sku,location,lot_number,expiration_date from post_cutoff
      )
      select k.sku,k.location,k.lot_number,k.expiration_date,
             (coalesce(c.quantity,0)-coalesce(p.quantity_delta,0))::numeric closing_quantity
      from keys k
      left join current_stock c using (sku,location,lot_number,expiration_date)
      left join post_cutoff p using (sku,location,lot_number,expiration_date)
      where (coalesce(c.quantity,0)-coalesce(p.quantity_delta,0)) <> 0
      order by k.sku,k.location,k.lot_number,k.expiration_date`, [ACCOUNT, cutoff]);
    const allocations = await db.query(`
      select l.sku,sum(a.allocated_quantity)::numeric allocated_quantity
      from portal_order_allocations a
      join portal_orders o on o.id=a.order_id
      join portal_order_lines l on l.id=a.order_line_id
      where o.account_name=$1
        and o.created_at < ($2::date::timestamp at time zone 'America/Toronto')
        and (
          (o.confirmed_ship_date is not null and o.confirmed_ship_date >= $2::date)
          or (
            o.confirmed_ship_date is null
            and (o.shipped_at is null or o.shipped_at >= ($2::date::timestamp at time zone 'America/Toronto'))
          )
        )
        and o.status <> 'CANCELLED'
      group by l.sku order by l.sku`, [ACCOUNT, cutoff]);
    const postCutoff = await db.query(`
      select count(*)::integer transaction_count,coalesce(sum(quantity_delta),0)::numeric net_change
      from inventory_transactions
      where account_name=$1 and server_timestamp >= ($2::date::timestamp at time zone 'America/Toronto')`, [ACCOUNT, cutoff]);

    const report = {
      account: ACCOUNT,
      cutoff,
      generatedAt: new Date().toISOString(),
      catalog: catalog.rows,
      closingByLocation: closingByLocation.rows,
      allocations: allocations.rows,
      reconciliation: postCutoff.rows[0]
    };
    console.log(JSON.stringify({
      account: ACCOUNT,
      cutoff,
      skuCount: catalog.rowCount,
      locationRows: closingByLocation.rowCount,
      allocationRows: allocations.rowCount,
      reportGzipBase64: zlib.gzipSync(Buffer.from(JSON.stringify(report))).toString("base64")
    }));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
module.exports = { main };
