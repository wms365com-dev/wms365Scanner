"use strict";

const { Client } = require("pg");

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const order = (await db.query(
      "select id, order_code, account_name, status, fulfillment_location_id from portal_orders where order_code = $1",
      ["ORD-001794"]
    )).rows[0];
    if (!order) throw new Error("ORD-001794 was not found.");
    const [restrictions, activities, tasks, users] = await Promise.all([
      db.query(
        `select user_email, user_name, user_role, request_method, request_path,
                resource_type, resource_id, account_name, reason, created_at
           from access_restriction_log
          where created_at >= now() - interval '14 days'
            and (resource_id = $1 or request_path like $2 or account_name = $3)
          order by created_at desc limit 100`,
        [String(order.id), `%/${order.id}/%`, order.account_name]
      ),
      db.query(
        `select type, title, details, created_at from activity_log
          where created_at >= now() - interval '14 days'
            and (title ilike $1 or details ilike $1)
          order by created_at desc limit 100`,
        [`%${order.order_code}%`]
      ),
      db.query(
        `select id, task_type, status, assigned_app_user_id, blocked_reason, metadata, updated_at
           from warehouse_tasks
          where source_type = 'PORTAL_ORDER' and source_id = $1
          order by id`,
        [order.id]
      ),
      db.query(
        `select distinct u.id, u.email, u.full_name, u.role, u.is_active
           from app_users u
           join app_user_companies c on c.app_user_id = u.id
          where c.account_name = $1
          order by u.id`,
        [order.account_name]
      ).catch(() => ({ rows: [] })),
    ]);
    await db.query("rollback");
    console.log(JSON.stringify({
      order,
      accessRestrictions: restrictions.rows,
      activities: activities.rows,
      warehouseTasks: tasks.rows,
      assignedUsers: users.rows,
    }, null, 2));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
