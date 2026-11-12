const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { once } = require("events");
const { Pool } = require("pg");

async function writeLine(stream, value) {
    if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function main() {
    const outputDir = path.resolve(process.argv[2] || "");
    const connectionString = process.env.DATABASE_URL || "";
    if (!outputDir || outputDir === path.parse(outputDir).root) throw new Error("A safe output directory is required.");
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, "production-database.jsonl.gz");
    const pool = new Pool({
        connectionString,
        ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false }
    });
    const client = await pool.connect();
    const gzip = zlib.createGzip({ level: 9 });
    const file = fs.createWriteStream(outputPath, { flags: "wx" });
    gzip.pipe(file);
    const manifest = {
        format: "wms365-jsonl-v1",
        createdAt: new Date().toISOString(),
        database: "production",
        tables: [],
        sequences: []
    };

    try {
        const tableResult = await client.query(
            "select tablename from pg_tables where schemaname = 'public' order by tablename"
        );
        const sequenceResult = await client.query(
            "select sequencename, last_value from pg_sequences where schemaname = 'public' order by sequencename"
        );
        manifest.sequences = sequenceResult.rows;
        await writeLine(gzip, { type: "manifest-start", ...manifest, tables: undefined });

        for (const { tablename } of tableResult.rows) {
            const columns = await client.query(
                `
                    select column_name, data_type, is_nullable, column_default
                    from information_schema.columns
                    where table_schema = 'public' and table_name = $1
                    order by ordinal_position
                `,
                [tablename]
            );
            const constraints = await client.query(
                `
                    select conname, pg_get_constraintdef(c.oid) as definition
                    from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                    where n.nspname = 'public' and t.relname = $1
                    order by conname
                `,
                [tablename]
            );
            const rows = await client.query(`select * from "${tablename.replace(/"/g, '""')}"`);
            const tableManifest = {
                name: tablename,
                rowCount: rows.rowCount,
                columns: columns.rows,
                constraints: constraints.rows
            };
            manifest.tables.push(tableManifest);
            await writeLine(gzip, { type: "table", ...tableManifest });
            for (const row of rows.rows) await writeLine(gzip, { type: "row", table: tablename, data: row });
        }
        await writeLine(gzip, { type: "manifest-end", tableCounts: manifest.tables.map(({ name, rowCount }) => ({ name, rowCount })) });
        gzip.end();
        await once(file, "close");
    } finally {
        client.release();
        await pool.end();
    }

    const compressed = fs.readFileSync(outputPath);
    const decompressed = zlib.gunzipSync(compressed).toString("utf8");
    const lines = decompressed.trim().split("\n").map((line) => JSON.parse(line));
    const exportedRows = lines.filter((line) => line.type === "row").length;
    const expectedRows = manifest.tables.reduce((sum, table) => sum + table.rowCount, 0);
    if (exportedRows !== expectedRows || !lines.some((line) => line.type === "manifest-end")) {
        throw new Error(`Backup verification failed: expected ${expectedRows} rows, read ${exportedRows}.`);
    }

    const checksum = crypto.createHash("sha256").update(compressed).digest("hex");
    const verification = {
        verified: true,
        file: outputPath,
        bytes: compressed.length,
        sha256: checksum,
        tableCount: manifest.tables.length,
        rowCount: exportedRows,
        createdAt: manifest.createdAt
    };
    fs.writeFileSync(path.join(outputDir, "database-backup-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
    process.stdout.write(JSON.stringify(verification));
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
