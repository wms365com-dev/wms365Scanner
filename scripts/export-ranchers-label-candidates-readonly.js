"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { main: readSnapshot } = require("./read-ranchers-clickship-queue");
const { build, HEADERS } = require("./prepare-ranchers-clickship-rows");

async function main() {
  const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection unavailable");
  const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
  await db.connect();
  try {
    const snapshot = await readSnapshot({ client: db, print: false, statuses: ["RELEASED", "STAGED"] });
    const built = build(snapshot);
    const output = path.resolve("outputs", "ranchers-label-sheet", "manual-candidates-20261105.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({
      generatedAt: new Date().toISOString(),
      account: snapshot.account,
      store: snapshot.store,
      warehouse: snapshot.warehouse,
      integrationId: snapshot.integrationId,
      headers: HEADERS,
      rows: built.rows,
    }, null, 2));
    console.log(JSON.stringify({ output, candidateCount: built.rows.length,
      orderCodes: built.rows.map((row) => row[1]) }));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
