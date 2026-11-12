const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  try {
    const email = await pool.query(`
      select status, provider, to_addresses, cc_addresses, message_id, sent_at
      from email_delivery_log where delivery_key = 'order-routing:1341' limit 1
    `);
    const appointment = await pool.query(`
      select status, recipient_email, sent_at
      from order_routing_requests where order_id = 1341 order by id desc limit 1
    `);
    console.log(JSON.stringify({ email: email.rows[0] || null, appointment: appointment.rows[0] || null }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
