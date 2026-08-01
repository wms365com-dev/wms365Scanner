const { Client } = require("pg");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const schema = `wms365_boot_${crypto.randomBytes(6).toString("hex")}`;
    const admin = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await admin.connect();
    await admin.query(`create schema ${schema}`);

    const isolatedUrl = new URL(connectionString);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const port = 18997;
    const child = spawn(process.execPath, ["server.js"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            DATABASE_URL: isolatedUrl.toString(),
            DATABASE_PRIVATE_URL: "",
            PORT: String(port),
            WAREHOUSE_BILLING_EMAIL_ENABLED: "false"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    try {
        let healthy = false;
        for (let attempt = 0; attempt < 90; attempt += 1) {
            if (child.exitCode != null) break;
            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/health`);
                const payload = await response.json();
                if (response.ok && payload?.ok === true && payload?.databaseReady === true) {
                    healthy = true;
                    break;
                }
            } catch (_error) {
                // Startup is still applying the boot schema.
            }
            await sleep(1000);
        }
        if (!healthy) throw new Error(`Fresh database boot did not become healthy.\n${output.slice(-4000)}`);
        const checks = await admin.query(
            `select
                to_regclass($1) is not null as inventory,
                to_regclass($2) is not null as shipments,
                to_regclass($3) is not null as jobs,
                to_regclass($4) is not null as approvals,
                to_regclass($5) is not null as billing_snapshots`,
            [
                `${schema}.inventory_transactions`,
                `${schema}.warehouse_shipments`,
                `${schema}.async_jobs`,
                `${schema}.partner_api_approvals`,
                `${schema}.storage_billing_snapshots`
            ]
        );
        const failed = Object.entries(checks.rows[0]).filter(([, value]) => value !== true);
        if (failed.length) throw new Error(`Fresh boot missing: ${failed.map(([name]) => name).join(", ")}`);
        console.log(JSON.stringify({ freshBoot: true, schemaControls: checks.rows[0] }));
    } finally {
        child.kill("SIGTERM");
        await sleep(500);
        await admin.query(`drop schema if exists ${schema} cascade`);
        await admin.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
