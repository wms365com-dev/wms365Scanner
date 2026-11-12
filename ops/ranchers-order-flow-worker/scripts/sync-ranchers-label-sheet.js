const { Client } = require("pg");
const { SheetsClient, configuredGoogleAuth, syncOnce } = require("../ranchers-label-sheet-sync");
const { main: readSnapshot } = require("./read-ranchers-clickship-queue");

async function run() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("WMS365 database connection unavailable");
    const auth = configuredGoogleAuth();
    const sheets = new SheetsClient(auth);
    const database = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await database.connect();
    try {
        const result = await syncOnce({
            database, sheets,
            loadSnapshot: (client) => readSnapshot({ client, print: false,
                statuses: ["RELEASED", "STAGED"] })
        });
        console.log(JSON.stringify({ state: result.state, appendedCount: result.appended.length,
            orderCodes: result.appended, candidates: result.candidates || 0 }));
    } finally {
        await database.end();
    }
}

async function main() {
    const watch = process.argv.includes("--watch");
    do {
        try {
            await run();
        } catch (error) {
            console.error(`Rancher's label-sheet sync failed: ${error.message || error}`);
            if (!watch) {
                process.exitCode = 1;
                return;
            }
        }
        if (watch) await new Promise((resolve) => setTimeout(resolve, 60_000));
    } while (watch);
}

main();
