const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ROOT_DIR = __dirname;
const DATABASE_URL = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("DATABASE_URL or DATABASE_PRIVATE_URL is required. Add a PostgreSQL database in Railway and expose it to this service.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
});

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res, next) => {
    try {
        await pool.query("select 1");
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.get("/api/state", async (_req, res, next) => {
    try {
        res.json(await getServerState());
    } catch (error) {
        next(error);
    }
});

app.get("/api/export", async (_req, res, next) => {
    try {
        res.json({
            app: "WMS365 Scanner",
            exportedAt: new Date().toISOString(),
            ...(await getServerState())
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/batch-save", async (req, res, next) => {
    try {
        const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
        if (inputItems.length === 0) {
            throw httpError(400, "At least one batch line is required.");
        }

        const items = groupInventoryInputs(inputItems);
        const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
        const locationCount = new Set(items.map((item) => item.location)).size;

        await withTransaction(async (client) => {
            for (const item of items) {
                await upsertInventoryLine(client, item.location, item.sku, item.upc, item.quantity);
            }

            await insertActivity(
                client,
                "scan",
                `Saved ${formatCount(items.length, "staged line")} to inventory`,
                `${formatNumber(totalUnits)} units across ${formatCount(locationCount, "location")}.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/remove-quantity", async (req, res, next) => {
    try {
        const location = normalizeText(req.body?.location);
        const skuOrUpc = normalizeText(req.body?.skuOrUpc);
        const quantity = toPositiveInt(req.body?.quantity);

        if (!location || !skuOrUpc || !quantity) {
            throw httpError(400, "Location, SKU/UPC, and quantity are required.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, location, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that location and SKU/UPC.");
            }
            if (quantity > Number(line.quantity)) {
                throw httpError(400, `Cannot remove ${formatNumber(quantity)} units because only ${formatNumber(line.quantity)} are available.`);
            }

            const remaining = Number(line.quantity) - quantity;
            await setInventoryQuantity(client, line.id, remaining);
            await insertActivity(
                client,
                "delete",
                `Removed ${formatNumber(quantity)} units of ${line.sku}`,
                `${line.location} now has ${formatNumber(remaining)} units remaining.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/delete-line", async (req, res, next) => {
    try {
        const location = normalizeText(req.body?.location);
        const skuOrUpc = normalizeText(req.body?.skuOrUpc);

        if (!location || !skuOrUpc) {
            throw httpError(400, "Location and SKU/UPC are required.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, location, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that location and SKU/UPC.");
            }

            await client.query("delete from inventory_lines where id = $1", [line.id]);
            await insertActivity(
                client,
                "delete",
                `Deleted ${line.sku} from ${line.location}`,
                `${formatNumber(line.quantity)} units were removed from inventory.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/transfer", async (req, res, next) => {
    try {
        const fromLocation = normalizeText(req.body?.fromLocation);
        const toLocation = normalizeText(req.body?.toLocation);
        const skuOrUpc = normalizeText(req.body?.skuOrUpc);
        const quantity = toPositiveInt(req.body?.quantity);

        if (!fromLocation || !toLocation || !skuOrUpc || !quantity) {
            throw httpError(400, "From location, to location, SKU/UPC, and quantity are required.");
        }
        if (fromLocation === toLocation) {
            throw httpError(400, "Source and destination locations cannot be the same.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, fromLocation, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched the source location and SKU/UPC.");
            }
            if (quantity > Number(line.quantity)) {
                throw httpError(400, `Cannot transfer ${formatNumber(quantity)} units because only ${formatNumber(line.quantity)} are available.`);
            }

            await setInventoryQuantity(client, line.id, Number(line.quantity) - quantity);
            await upsertInventoryLine(client, toLocation, line.sku, line.upc, quantity);
            await insertActivity(
                client,
                "transfer",
                `Transferred ${formatNumber(quantity)} units of ${line.sku}`,
                `${fromLocation} -> ${toLocation}`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/move-location", async (req, res, next) => {
    try {
        const fromLocation = normalizeText(req.body?.fromLocation);
        const toLocation = normalizeText(req.body?.toLocation);

        if (!fromLocation || !toLocation) {
            throw httpError(400, "From location and to location are required.");
        }
        if (fromLocation === toLocation) {
            throw httpError(400, "Source and destination locations cannot be the same.");
        }

        await withTransaction(async (client) => {
            const linesResult = await client.query(
                "select * from inventory_lines where location = $1 order by sku asc",
                [fromLocation]
            );

            if (linesResult.rowCount === 0) {
                throw httpError(404, `No inventory lines were found at ${fromLocation}.`);
            }

            let totalUnits = 0;
            for (const line of linesResult.rows) {
                totalUnits += Number(line.quantity);
                await upsertInventoryLine(client, toLocation, line.sku, line.upc, Number(line.quantity));
            }

            await client.query("delete from inventory_lines where location = $1", [fromLocation]);
            await insertActivity(
                client,
                "move",
                `Moved ${formatCount(linesResult.rowCount, "line")} from ${fromLocation}`,
                `${formatNumber(totalUnits)} total units moved to ${toLocation}.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/import", async (req, res, next) => {
    try {
        const importedInventory = Array.isArray(req.body?.inventory) ? req.body.inventory.map(sanitizeInventoryLineInput).filter(Boolean) : [];
        const importedActivity = Array.isArray(req.body?.activity) ? req.body.activity.map(sanitizeActivityInput).filter(Boolean) : [];

        await withTransaction(async (client) => {
            await client.query("truncate table activity_log, inventory_lines restart identity");

            for (const line of importedInventory) {
                await client.query(
                    `
                        insert into inventory_lines (location, sku, upc, quantity, created_at, updated_at)
                        values ($1, $2, $3, $4, $5, $6)
                    `,
                    [line.location, line.sku, line.upc, line.quantity, line.createdAt, line.updatedAt]
                );
            }

            for (const item of importedActivity) {
                await client.query(
                    `
                        insert into activity_log (type, title, details, created_at)
                        values ($1, $2, $3, $4)
                    `,
                    [item.type, item.title, item.details, item.timestamp]
                );
            }

            await insertActivity(
                client,
                "import",
                "Imported JSON backup",
                `${formatCount(importedInventory.length, "inventory line")} restored.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get("/", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/index.html", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/favicon.ico", (_req, res) => {
    res.status(204).end();
});

app.use((error, _req, res, _next) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
        console.error(error);
    }
    res.status(statusCode).json({
        error: error.message || "An unexpected server error occurred."
    });
});

start().catch((error) => {
    console.error(error);
    process.exit(1);
});

async function start() {
    await initializeDatabase();
    app.listen(PORT, () => {
        console.log(`WMS365 Scanner server listening on port ${PORT}`);
    });
}

async function initializeDatabase() {
    await pool.query(`
        create table if not exists inventory_lines (
            id bigserial primary key,
            location text not null,
            sku text not null,
            upc text not null default '',
            quantity integer not null check (quantity > 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint inventory_lines_location_sku_unique unique (location, sku)
        );
    `);

    await pool.query(`
        create table if not exists activity_log (
            id bigserial primary key,
            type text not null,
            title text not null,
            details text not null default '',
            created_at timestamptz not null default now()
        );
    `);

    await pool.query("create index if not exists idx_inventory_lines_location on inventory_lines (location);");
    await pool.query("create index if not exists idx_inventory_lines_sku on inventory_lines (sku);");
    await pool.query("create index if not exists idx_inventory_lines_upc on inventory_lines (upc);");
    await pool.query("create index if not exists idx_activity_log_created_at on activity_log (created_at desc);");
}

async function getServerState(client = pool) {
    const [inventoryResult, activityResult, metaResult] = await Promise.all([
        client.query("select * from inventory_lines order by location asc, sku asc"),
        client.query("select * from activity_log order by created_at desc limit $1", [80]),
        client.query(`
            select nullif(
                greatest(
                    coalesce((select max(updated_at) from inventory_lines), to_timestamp(0)),
                    coalesce((select max(created_at) from activity_log), to_timestamp(0))
                ),
                to_timestamp(0)
            ) as last_changed_at
        `)
    ]);

    return {
        inventory: inventoryResult.rows.map(mapInventoryRow),
        activity: activityResult.rows.map(mapActivityRow),
        meta: {
            version: 2,
            lastChangedAt: metaResult.rows[0].last_changed_at ? new Date(metaResult.rows[0].last_changed_at).toISOString() : null,
            serverSyncedAt: new Date().toISOString()
        }
    };
}

async function withTransaction(handler) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const result = await handler(client);
        await client.query("commit");
        return result;
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        client.release();
    }
}

async function upsertInventoryLine(client, location, sku, upc, quantity) {
    await client.query(
        `
            insert into inventory_lines (location, sku, upc, quantity)
            values ($1, $2, $3, $4)
            on conflict (location, sku)
            do update set
                upc = case
                    when inventory_lines.upc = '' and excluded.upc <> '' then excluded.upc
                    else inventory_lines.upc
                end,
                quantity = inventory_lines.quantity + excluded.quantity,
                updated_at = now()
        `,
        [location, sku, upc, quantity]
    );
}

async function setInventoryQuantity(client, lineId, quantity) {
    if (quantity <= 0) {
        await client.query("delete from inventory_lines where id = $1", [lineId]);
        return;
    }
    await client.query("update inventory_lines set quantity = $1, updated_at = now() where id = $2", [quantity, lineId]);
}

async function insertActivity(client, type, title, details) {
    await client.query(
        "insert into activity_log (type, title, details) values ($1, $2, $3)",
        [type, title, details]
    );
}

async function findInventoryLine(client, location, skuOrUpc) {
    const skuMatch = await client.query(
        "select * from inventory_lines where location = $1 and sku = $2 limit 1",
        [location, skuOrUpc]
    );
    if (skuMatch.rowCount === 1) {
        return skuMatch.rows[0];
    }

    const upcMatches = await client.query(
        "select * from inventory_lines where location = $1 and upc = $2 order by sku asc limit 2",
        [location, skuOrUpc]
    );

    if (upcMatches.rowCount > 1) {
        throw httpError(400, "Multiple items matched that UPC at the selected location. Use the SKU instead.");
    }

    return upcMatches.rowCount === 1 ? upcMatches.rows[0] : null;
}

function groupInventoryInputs(lines) {
    const grouped = new Map();
    for (const rawLine of lines) {
        const line = sanitizeInventoryLineInput(rawLine);
        if (!line) {
            throw httpError(400, "Each batch line must include a location, SKU, and positive quantity.");
        }
        const key = `${line.location}::${line.sku}`;
        const current = grouped.get(key) || { location: line.location, sku: line.sku, upc: line.upc, quantity: 0 };
        current.quantity += line.quantity;
        if (!current.upc && line.upc) current.upc = line.upc;
        grouped.set(key, current);
    }
    return [...grouped.values()];
}

function sanitizeInventoryLineInput(line) {
    const location = normalizeText(line?.location);
    const sku = normalizeText(line?.sku);
    const upc = normalizeText(line?.upc || "");
    const quantity = toPositiveInt(line?.quantity);
    if (!location || !sku || !quantity) return null;
    return {
        location,
        sku,
        upc,
        quantity,
        createdAt: typeof line?.createdAt === "string" ? line.createdAt : new Date().toISOString(),
        updatedAt: typeof line?.updatedAt === "string" ? line.updatedAt : new Date().toISOString()
    };
}

function sanitizeActivityInput(item) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    if (!title) return null;
    return {
        type: typeof item?.type === "string" ? item.type.toLowerCase() : "scan",
        title,
        details: typeof item?.details === "string" ? item.details.trim() : "",
        timestamp: typeof item?.timestamp === "string" ? item.timestamp : new Date().toISOString()
    };
}

function mapInventoryRow(row) {
    return {
        id: String(row.id),
        location: row.location,
        sku: row.sku,
        upc: row.upc || "",
        quantity: Number(row.quantity),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapActivityRow(row) {
    return {
        id: String(row.id),
        type: row.type,
        title: row.title,
        details: row.details || "",
        timestamp: new Date(row.created_at).toISOString()
    };
}

function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function toPositiveInt(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function shouldUseSsl(connectionString) {
    if (process.env.DATABASE_PRIVATE_URL && connectionString === process.env.DATABASE_PRIVATE_URL) {
        return false;
    }
    if (/sslmode=disable/i.test(connectionString)) {
        return false;
    }
    return process.env.PGSSL !== "false";
}

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function formatNumber(value) {
    return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatCount(value, noun) {
    return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}
