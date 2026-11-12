const fs = require("fs");
const path = require("path");
const { main: readSnapshot } = require("./read-ranchers-clickship-queue");
const { build } = require("./prepare-ranchers-clickship-rows");

async function main() {
    const existing = new Set(JSON.parse(fs.readFileSync(
        path.join(__dirname, "..", "outputs", "ranchers-label-sync-existing-20261103.json"),
        "utf8"
    )));
    const snapshot = await readSnapshot({
        print: false,
        statuses: ["RELEASED", "STAGED"]
    });
    const result = build(snapshot);
    const rows = result.rows.filter((row) => !existing.has(row[1]));
    console.log(JSON.stringify({
        scope: {
            account: snapshot.account,
            integrationId: snapshot.integrationId,
            store: snapshot.store,
            warehouse: snapshot.warehouse,
            warehouseId: snapshot.warehouseId
        },
        candidateCount: result.rows.length,
        appendCount: rows.length,
        orderCodes: rows.map((row) => row[1]),
        rows,
        excluded: result.excluded
    }));
}

main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
});
