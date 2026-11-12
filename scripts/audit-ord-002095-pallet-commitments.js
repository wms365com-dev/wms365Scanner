"use strict";

const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const result = await pool.query(
      `select i.id inventory_line_id, i.location, i.sku, i.quantity,
              o.order_code, o.status, a.allocated_quantity
         from inventory_lines i
         left join portal_order_allocations a on a.inventory_line_id = i.id
         left join portal_orders o on o.id = a.order_id
        where i.account_name = 'ALCONA TRADING LTD'
          and i.sku = 'MS26062403'
          and upper(i.location) = any($1::text[])
        order by i.location, o.order_code`,
      [["DJ08AA", "DJ08AB", "DJ06AA", "DJ06AB"]]
    );
    console.log(JSON.stringify(result.rows));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
