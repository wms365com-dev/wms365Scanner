const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SESSION_FILE = path.join(__dirname, "..", ".tmp", "exim-outbound-guide-session.json");

async function main() {
    if (!fs.existsSync(SESSION_FILE)) return;
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        await pool.query("delete from portal_sessions where id = $1 and token_hash = $2", [session.sessionId, session.tokenHash]);
    } finally {
        await pool.end();
        fs.rmSync(SESSION_FILE, { force: true });
    }
    console.log(JSON.stringify({ guideSessionDeleted: true }));
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
