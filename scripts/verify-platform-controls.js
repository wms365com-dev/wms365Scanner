const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });
    await client.connect();
    try {
        const result = await client.query(`
            select
                to_regclass('public.warehouse_task_history') is not null as task_history,
                to_regclass('public.billing_event_audit') is not null as billing_audit,
                exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'inventory_count_records'
                      and column_name = 'variance_severity'
                ) as count_controls,
                exists (
                    select 1
                    from pg_trigger
                    where tgname = 'warehouse_task_history_immutable'
                      and not tgisinternal
                ) as task_history_immutable,
                exists (
                    select 1
                    from pg_trigger
                    where tgname = 'billing_event_control_trigger'
                      and not tgisinternal
                ) as billing_event_control
        `);
        const checks = result.rows[0];
        const failed = Object.entries(checks).filter(([, value]) => value !== true);
        console.log(JSON.stringify(checks));
        if (failed.length) {
            throw new Error(`Missing controls: ${failed.map(([name]) => name).join(", ")}`);
        }
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
