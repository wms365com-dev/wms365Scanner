const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ROOT_DIR = __dirname;
const DATABASE_URL = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
const LEGACY_ACCOUNT = "LEGACY";

if (!DATABASE_URL) {
    console.error("DATABASE_URL or DATABASE_PRIVATE_URL is required. Add a PostgreSQL database in Railway and expose it to this service.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
});

let databaseReady = false;
let databaseErrorMessage = "";
let databaseInitStartedAt = null;

pool.on("error", (error) => {
    databaseReady = false;
    databaseErrorMessage = error.message;
    console.error("Unexpected PostgreSQL pool error:", error);
});

const app = express();

app.use(express.json({ limit: "3mb" }));

app.get("/api/health", (_req, res) => {
    res.json({
        ok: true,
        databaseReady,
        databaseError: databaseErrorMessage || null,
        startedInitializingAt: databaseInitStartedAt
    });
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

app.post("/api/master-location", async (req, res, next) => {
    try {
        const entry = sanitizeLocationMasterInput(req.body);
        if (!entry) {
            throw httpError(400, "A BIN or location code is required.");
        }

        await withTransaction(async (client) => {
            await upsertLocationMaster(client, entry.code, entry.note);
            await insertActivity(
                client,
                "setup",
                `Saved BIN ${entry.code}`,
                entry.note ? entry.note : "BIN/location added to the shared quick-pick library."
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/master-owner", async (req, res, next) => {
    try {
        const entry = sanitizeOwnerMasterInput(req.body);
        if (!entry) {
            throw httpError(400, "A vendor / customer name is required.");
        }

        await withTransaction(async (client) => {
            await upsertOwnerMaster(client, entry.name, entry.note);
            await insertActivity(
                client,
                "setup",
                `Saved vendor / customer ${entry.name}`,
                entry.note ? entry.note : "Vendor / customer added to the shared quick-pick library."
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/master-item", async (req, res, next) => {
    try {
        const entry = sanitizeItemMasterInput(req.body);
        if (!entry || !entry.accountName || !entry.sku) {
            throw httpError(400, "Vendor / Customer and SKU are required.");
        }

        await withTransaction(async (client) => {
            await upsertOwnerMaster(client, entry.accountName);
            await upsertItemMaster(client, entry);
            await insertActivity(
                client,
                "setup",
                `Saved item ${entry.accountName} / ${entry.sku}`,
                [
                    entry.upc ? `UPC ${entry.upc}` : "",
                    entry.trackingLevel === "PALLET" ? "Pallet tracking" : (entry.trackingLevel === "CASE" ? "Case tracking" : "Unit tracking"),
                    entry.description,
                    entry.imageUrl ? "Photo attached" : ""
                ].filter(Boolean).join(" | ") || "Item master saved."
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/master-item/update", async (req, res, next) => {
    try {
        const originalAccountName = normalizeText(req.body?.originalAccountName || req.body?.accountName || req.body?.owner || req.body?.vendor || req.body?.customer);
        const originalSku = normalizeText(req.body?.originalSku);
        const entry = sanitizeItemMasterInput(req.body);

        if (!originalAccountName || !originalSku) {
            throw httpError(400, "The original vendor / customer and SKU are required to update an item.");
        }
        if (!entry || !entry.accountName || !entry.sku) {
            throw httpError(400, "Vendor / Customer and SKU are required.");
        }
        if (entry.accountName !== originalAccountName) {
            throw httpError(400, "Changing vendor / customer from the item editor is not supported.");
        }

        const updatedItem = await withTransaction(async (client) => {
            const mergedEntry = await updateItemMasterAndInventory(client, originalAccountName, originalSku, entry);
            await insertActivity(
                client,
                "setup",
                `Updated item ${originalAccountName} / ${originalSku}${mergedEntry.sku !== originalSku ? ` -> ${mergedEntry.sku}` : ""}`,
                [
                    mergedEntry.upc ? `UPC ${mergedEntry.upc}` : "",
                    mergedEntry.description || "",
                    mergedEntry.imageUrl ? "Photo attached" : ""
                ].filter(Boolean).join(" | ") || "Item master updated."
            );
            return mergedEntry;
        });

        res.json({ success: true, item: updatedItem });
    } catch (error) {
        next(error);
    }
});

app.post("/api/master-items/import", async (req, res, next) => {
    try {
        const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!inputItems.length) {
            throw httpError(400, "At least one item master row is required.");
        }

        const items = groupItemMasterInputs(inputItems);

        await withTransaction(async (client) => {
            for (const item of items) {
                await upsertOwnerMaster(client, item.accountName);
                await upsertItemMaster(client, item);
            }

            await insertActivity(
                client,
                "setup",
                `Imported ${formatCount(items.length, "item master")} from CSV`,
                "Shared item library updated from spreadsheet import."
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/master-locations/import", async (req, res, next) => {
    try {
        const inputLocations = Array.isArray(req.body?.locations) ? req.body.locations : [];
        if (!inputLocations.length) {
            throw httpError(400, "At least one BIN location is required.");
        }

        const locations = groupLocationMasterInputs(inputLocations);

        await withTransaction(async (client) => {
            for (const location of locations) {
                await upsertLocationMaster(client, location.code, location.note);
            }

            await insertActivity(
                client,
                "setup",
                `Imported ${formatCount(locations.length, "BIN")} from CSV`,
                "Shared BIN library updated from spreadsheet import."
            );
        });

        res.json({ success: true });
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
        const ownerCount = new Set(items.map((item) => item.accountName)).size;
        const locationCount = new Set(items.map((item) => `${item.accountName}::${item.location}`)).size;

        await withTransaction(async (client) => {
            for (const rawItem of items) {
                const master = await findCatalogItem(client, rawItem.accountName, rawItem.sku, rawItem.upc);
                const item = {
                    ...rawItem,
                    upc: rawItem.upc || master?.upc || "",
                    trackingLevel: rawItem.trackingLevel || master?.trackingLevel || "UNIT"
                };

                await upsertOwnerMaster(client, item.accountName);
                await upsertInventoryLine(client, item);
                await upsertLocationMaster(client, item.location);
                await upsertItemMaster(client, {
                    accountName: item.accountName,
                    sku: item.sku,
                    upc: item.upc,
                    description: rawItem.description || master?.description || "",
                    imageUrl: rawItem.imageUrl || master?.imageUrl || "",
                    trackingLevel: item.trackingLevel,
                    unitsPerCase: master?.unitsPerCase ?? null,
                    eachLength: master?.eachLength ?? null,
                    eachWidth: master?.eachWidth ?? null,
                    eachHeight: master?.eachHeight ?? null,
                    caseLength: master?.caseLength ?? null,
                    caseWidth: master?.caseWidth ?? null,
                    caseHeight: master?.caseHeight ?? null
                });
            }

            await insertActivity(
                client,
                "scan",
                `Saved ${formatCount(items.length, "staged line")} to inventory`,
                `${formatCount(ownerCount, "owner")} | ${formatCount(locationCount, "location")} | ${formatTrackedSummaryFromItems(items)}`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/remove-quantity", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner);
        const location = normalizeText(req.body?.location);
        const skuOrUpc = normalizeText(req.body?.skuOrUpc);
        const quantity = toPositiveInt(req.body?.quantity);

        if (!accountName || !location || !skuOrUpc || !quantity) {
            throw httpError(400, "Vendor / Customer, location, SKU/UPC, and quantity are required.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, accountName, location, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that vendor/customer, location, and SKU/UPC.");
            }
            if (quantity > Number(line.quantity)) {
                throw httpError(400, `Cannot remove ${formatTrackedQuantity(quantity, line.tracking_level)} because only ${formatTrackedQuantity(Number(line.quantity), line.tracking_level)} are available.`);
            }

            const remaining = Number(line.quantity) - quantity;
            await setInventoryQuantity(client, line.id, remaining);
            await insertActivity(
                client,
                "delete",
                `Removed ${formatTrackedQuantity(quantity, line.tracking_level)} of ${line.account_name} / ${line.sku}`,
                `${line.location} now has ${formatTrackedQuantity(remaining, line.tracking_level)} remaining.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/delete-line", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner);
        const location = normalizeText(req.body?.location);
        const skuOrUpc = normalizeText(req.body?.skuOrUpc);

        if (!accountName || !location || !skuOrUpc) {
            throw httpError(400, "Vendor / Customer, location, and SKU/UPC are required.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, accountName, location, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that vendor/customer, location, and SKU/UPC.");
            }

            await client.query("delete from inventory_lines where id = $1", [line.id]);
            await insertActivity(
                client,
                "delete",
                `Deleted ${line.account_name} / ${line.sku} from ${line.location}`,
                `${formatTrackedQuantity(Number(line.quantity), line.tracking_level)} were removed from inventory.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/transfer", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner);
        const fromLocation = normalizeText(req.body?.fromLocation);
        const toLocation = normalizeText(req.body?.toLocation);
        const skuOrUpc = normalizeText(req.body?.skuOrUpc);
        const quantity = toPositiveInt(req.body?.quantity);

        if (!accountName || !fromLocation || !toLocation || !skuOrUpc || !quantity) {
            throw httpError(400, "Vendor / Customer, from location, to location, SKU/UPC, and quantity are required.");
        }
        if (fromLocation === toLocation) {
            throw httpError(400, "Source and destination locations cannot be the same.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, accountName, fromLocation, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that vendor/customer, source location, and SKU/UPC.");
            }
            if (quantity > Number(line.quantity)) {
                throw httpError(400, `Cannot transfer ${formatTrackedQuantity(quantity, line.tracking_level)} because only ${formatTrackedQuantity(Number(line.quantity), line.tracking_level)} are available.`);
            }
            await assertLocationCompatibleForOwner(client, accountName, toLocation);

            await setInventoryQuantity(client, line.id, Number(line.quantity) - quantity);
            await upsertInventoryLine(client, {
                accountName,
                location: toLocation,
                sku: line.sku,
                upc: line.upc,
                quantity,
                trackingLevel: line.tracking_level
            });
            await upsertLocationMaster(client, fromLocation);
            await upsertLocationMaster(client, toLocation);
            await upsertItemMaster(client, {
                accountName,
                sku: line.sku,
                upc: line.upc,
                trackingLevel: line.tracking_level
            });
            await insertActivity(
                client,
                "transfer",
                `Transferred ${formatTrackedQuantity(quantity, line.tracking_level)} of ${accountName} / ${line.sku}`,
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
        const accountName = normalizeText(req.body?.accountName || req.body?.owner);
        const fromLocation = normalizeText(req.body?.fromLocation);
        const toLocation = normalizeText(req.body?.toLocation);

        if (!accountName || !fromLocation || !toLocation) {
            throw httpError(400, "Vendor / Customer, from location, and to location are required.");
        }
        if (fromLocation === toLocation) {
            throw httpError(400, "Source and destination locations cannot be the same.");
        }

        await withTransaction(async (client) => {
            const linesResult = await client.query(
                "select * from inventory_lines where account_name = $1 and location = $2 order by sku asc",
                [accountName, fromLocation]
            );

            if (linesResult.rowCount === 0) {
                throw httpError(404, `No inventory lines were found for ${accountName} at ${fromLocation}.`);
            }
            await assertLocationCompatibleForOwner(client, accountName, toLocation);

            for (const line of linesResult.rows) {
                await upsertInventoryLine(client, {
                    accountName,
                    location: toLocation,
                    sku: line.sku,
                    upc: line.upc,
                    quantity: Number(line.quantity),
                    trackingLevel: line.tracking_level
                });
                await upsertItemMaster(client, {
                    accountName,
                    sku: line.sku,
                    upc: line.upc,
                    trackingLevel: line.tracking_level
                });
            }

            await upsertLocationMaster(client, fromLocation);
            await upsertLocationMaster(client, toLocation);
            await client.query("delete from inventory_lines where account_name = $1 and location = $2", [accountName, fromLocation]);
            await insertActivity(
                client,
                "move",
                `Moved ${formatCount(linesResult.rowCount, "line")} for ${accountName} from ${fromLocation}`,
                `${formatTrackedSummaryFromRows(linesResult.rows)} moved to ${toLocation}.`
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
        const importedLocations = Array.isArray(req.body?.masters?.locations) ? req.body.masters.locations.map(sanitizeLocationMasterInput).filter(Boolean) : [];
        const importedItems = Array.isArray(req.body?.masters?.items) ? req.body.masters.items.map(sanitizeItemMasterInput).filter(Boolean) : [];
        const importedOwners = Array.isArray(req.body?.masters?.ownerRecords)
            ? req.body.masters.ownerRecords.map(sanitizeOwnerMasterInput).filter(Boolean)
            : Array.isArray(req.body?.masters?.owners)
                ? req.body.masters.owners.map((owner) => sanitizeOwnerMasterInput(owner)).filter(Boolean)
                : [];

        await withTransaction(async (client) => {
            await client.query("truncate table activity_log, inventory_lines, bin_locations, item_catalog, owner_accounts restart identity");

            for (const line of importedInventory) {
                await client.query(
                    `
                        insert into inventory_lines (account_name, location, sku, upc, tracking_level, quantity, created_at, updated_at)
                        values ($1, $2, $3, $4, $5, $6, $7, $8)
                    `,
                    [line.accountName, line.location, line.sku, line.upc, line.trackingLevel, line.quantity, line.createdAt, line.updatedAt]
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

            for (const owner of importedOwners) {
                await client.query(
                    `
                        insert into owner_accounts (name, note, created_at, updated_at)
                        values ($1, $2, $3, $4)
                    `,
                    [owner.name, owner.note, owner.createdAt, owner.updatedAt]
                );
            }

            for (const location of importedLocations) {
                await client.query(
                    `
                        insert into bin_locations (code, note, created_at, updated_at)
                        values ($1, $2, $3, $4)
                    `,
                    [location.code, location.note, location.createdAt, location.updatedAt]
                );
            }

            for (const item of importedItems) {
                await client.query(
                    `
                        insert into item_catalog (
                            account_name, sku, upc, description, tracking_level, units_per_case,
                            each_length, each_width, each_height, image_url,
                            case_length, case_width, case_height,
                            created_at, updated_at
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `,
                    [
                        item.accountName,
                        item.sku,
                        item.upc,
                        item.description,
                        item.trackingLevel,
                        item.unitsPerCase,
                        item.eachLength,
                        item.eachWidth,
                        item.eachHeight,
                        item.imageUrl,
                        item.caseLength,
                        item.caseWidth,
                        item.caseHeight,
                        item.createdAt,
                        item.updatedAt
                    ]
                );
            }

            for (const line of importedInventory) {
                await upsertOwnerMaster(client, line.accountName);
                await upsertLocationMaster(client, line.location);
                await upsertItemMaster(client, {
                    accountName: line.accountName,
                    sku: line.sku,
                    upc: line.upc,
                    trackingLevel: line.trackingLevel
                });
            }

            await insertActivity(
                client,
                "import",
                "Imported JSON backup",
                `${formatCount(importedInventory.length, "inventory line")} restored, plus ${formatCount(importedOwners.length, "owner")}, ${formatCount(importedLocations.length, "BIN")}, and ${formatCount(importedItems.length, "item master")}.`
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
    app.listen(PORT, () => {
        console.log(`WMS365 Scanner server listening on port ${PORT}`);
    });

    void initializeDatabaseWithRetry();
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
            updated_at timestamptz not null default now()
        );
    `);
    await pool.query(`alter table inventory_lines add column if not exists account_name text not null default '${LEGACY_ACCOUNT}';`);
    await pool.query("alter table inventory_lines add column if not exists tracking_level text not null default 'UNIT';");
    await pool.query("update inventory_lines set account_name = $1 where account_name is null or account_name = ''", [LEGACY_ACCOUNT]);
    await pool.query("update inventory_lines set tracking_level = 'UNIT' where tracking_level is null or tracking_level = ''");
    await pool.query("alter table inventory_lines drop constraint if exists inventory_lines_location_sku_unique");

    await pool.query(`
        create table if not exists activity_log (
            id bigserial primary key,
            type text not null,
            title text not null,
            details text not null default '',
            created_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists bin_locations (
            id bigserial primary key,
            code text not null unique,
            note text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists owner_accounts (
            id bigserial primary key,
            name text not null unique,
            note text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists item_catalog (
            id bigserial primary key,
            sku text not null,
            upc text not null default '',
            description text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);
    await pool.query(`alter table item_catalog add column if not exists account_name text not null default '${LEGACY_ACCOUNT}';`);
    await pool.query("alter table item_catalog add column if not exists tracking_level text not null default 'UNIT';");
    await pool.query("alter table item_catalog add column if not exists units_per_case integer;");
    await pool.query("alter table item_catalog add column if not exists each_length double precision;");
    await pool.query("alter table item_catalog add column if not exists each_width double precision;");
    await pool.query("alter table item_catalog add column if not exists each_height double precision;");
    await pool.query("alter table item_catalog add column if not exists case_length double precision;");
    await pool.query("alter table item_catalog add column if not exists case_width double precision;");
    await pool.query("alter table item_catalog add column if not exists case_height double precision;");
    await pool.query("alter table item_catalog add column if not exists image_url text not null default '';");
    await pool.query("update item_catalog set account_name = $1 where account_name is null or account_name = ''", [LEGACY_ACCOUNT]);
    await pool.query("update item_catalog set tracking_level = 'UNIT' where tracking_level is null or tracking_level = ''");
    await pool.query("alter table item_catalog drop constraint if exists item_catalog_sku_key");

    await pool.query("create unique index if not exists idx_inventory_lines_account_location_sku_unique on inventory_lines (account_name, location, sku);");
    await pool.query("create unique index if not exists idx_item_catalog_account_sku_unique on item_catalog (account_name, sku);");
    await pool.query("create index if not exists idx_inventory_lines_account_name on inventory_lines (account_name);");
    await pool.query("create index if not exists idx_inventory_lines_location on inventory_lines (location);");
    await pool.query("create index if not exists idx_inventory_lines_sku on inventory_lines (sku);");
    await pool.query("create index if not exists idx_inventory_lines_upc on inventory_lines (upc);");
    await pool.query("create index if not exists idx_inventory_lines_tracking_level on inventory_lines (tracking_level);");
    await pool.query("create index if not exists idx_bin_locations_code on bin_locations (code);");
    await pool.query("create index if not exists idx_owner_accounts_name on owner_accounts (name);");
    await pool.query("create index if not exists idx_item_catalog_account_name on item_catalog (account_name);");
    await pool.query("create index if not exists idx_item_catalog_sku on item_catalog (sku);");
    await pool.query("create index if not exists idx_item_catalog_upc on item_catalog (upc);");
    await pool.query("create index if not exists idx_activity_log_created_at on activity_log (created_at desc);");

    await pool.query(`
        insert into owner_accounts (name)
        select distinct account_name
        from (
            select account_name from inventory_lines
            union
            select account_name from item_catalog
        ) owners
        where account_name <> ''
        on conflict (name) do nothing
    `);

    await pool.query(`
        insert into bin_locations (code)
        select distinct location
        from inventory_lines
        where location <> ''
        on conflict (code) do nothing
    `);

    await pool.query(`
        insert into item_catalog (account_name, sku, upc, tracking_level)
        select
            account_name,
            sku,
            coalesce(max(nullif(upc, '')), '') as upc
            ,
            coalesce(max(nullif(tracking_level, '')), 'UNIT') as tracking_level
        from inventory_lines
        where sku <> ''
        group by account_name, sku
        on conflict (account_name, sku)
        do update set
            upc = case
                when item_catalog.upc = '' and excluded.upc <> '' then excluded.upc
                else item_catalog.upc
            end,
            tracking_level = case
                when excluded.tracking_level <> '' then excluded.tracking_level
                else item_catalog.tracking_level
            end,
            updated_at = now()
    `);
}

async function initializeDatabaseWithRetry() {
    databaseInitStartedAt = new Date().toISOString();

    while (!databaseReady) {
        try {
            console.log("Initializing PostgreSQL schema...");
            await initializeDatabase();
            databaseReady = true;
            databaseErrorMessage = "";
            console.log("PostgreSQL schema ready.");
        } catch (error) {
            databaseReady = false;
            databaseErrorMessage = error.message;
            console.error("Database initialization failed. Retrying in 5 seconds.", error);
            await delay(5000);
        }
    }
}

async function getServerState(client = pool) {
    const [inventoryResult, activityResult, locationResult, ownerResult, itemResult, metaResult] = await Promise.all([
        client.query("select * from inventory_lines order by account_name asc, location asc, sku asc"),
        client.query("select * from activity_log order by created_at desc limit $1", [80]),
        client.query("select * from bin_locations order by code asc"),
        client.query("select * from owner_accounts order by name asc"),
        client.query("select * from item_catalog order by account_name asc, sku asc"),
        client.query(`
            select nullif(
                greatest(
                    coalesce((select max(updated_at) from inventory_lines), to_timestamp(0)),
                    coalesce((select max(created_at) from activity_log), to_timestamp(0)),
                    coalesce((select max(updated_at) from bin_locations), to_timestamp(0)),
                    coalesce((select max(updated_at) from owner_accounts), to_timestamp(0)),
                    coalesce((select max(updated_at) from item_catalog), to_timestamp(0))
                ),
                to_timestamp(0)
            ) as last_changed_at
        `)
    ]);

    const owners = [...new Set(
        ownerResult.rows.map((row) => row.name)
            .concat(inventoryResult.rows.map((row) => row.account_name))
            .concat(itemResult.rows.map((row) => row.account_name))
    )].filter(Boolean).sort();

    return {
        inventory: inventoryResult.rows.map(mapInventoryRow),
        activity: activityResult.rows.map(mapActivityRow),
        masters: {
            locations: locationResult.rows.map(mapLocationMasterRow),
            ownerRecords: ownerResult.rows.map(mapOwnerMasterRow),
            items: itemResult.rows.map(mapItemMasterRow),
            owners
        },
        meta: {
            version: 4,
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

async function upsertInventoryLine(client, item) {
    await client.query(
        `
            insert into inventory_lines (account_name, location, sku, upc, tracking_level, quantity)
            values ($1, $2, $3, $4, $5, $6)
            on conflict (account_name, location, sku)
            do update set
                upc = case
                    when inventory_lines.upc = '' and excluded.upc <> '' then excluded.upc
                    else inventory_lines.upc
                end,
                tracking_level = excluded.tracking_level,
                quantity = inventory_lines.quantity + excluded.quantity,
                updated_at = now()
        `,
        [item.accountName, item.location, item.sku, item.upc || "", item.trackingLevel || "UNIT", item.quantity]
    );
}

async function upsertLocationMaster(client, code, note = "") {
    const normalizedCode = normalizeText(code);
    if (!normalizedCode) return;
    const normalizedNote = normalizeFreeText(note);

    await client.query(
        `
            insert into bin_locations (code, note)
            values ($1, $2)
            on conflict (code)
            do update set
                note = case
                    when excluded.note <> '' then excluded.note
                    else bin_locations.note
                end,
                updated_at = now()
        `,
        [normalizedCode, normalizedNote]
    );
}

async function upsertOwnerMaster(client, name, note = "") {
    const normalizedName = normalizeText(name);
    if (!normalizedName) return;
    const normalizedNote = normalizeFreeText(note);

    await client.query(
        `
            insert into owner_accounts (name, note)
            values ($1, $2)
            on conflict (name)
            do update set
                note = case
                    when excluded.note <> '' then excluded.note
                    else owner_accounts.note
                end,
                updated_at = now()
        `,
        [normalizedName, normalizedNote]
    );
}

async function upsertItemMaster(client, item) {
    const entry = sanitizeItemMasterInput(item);
    if (!entry || !entry.accountName || !entry.sku) return;

    await client.query(
        `
            insert into item_catalog (
                account_name, sku, upc, description, tracking_level, units_per_case,
                each_length, each_width, each_height, image_url,
                case_length, case_width, case_height
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            on conflict (account_name, sku)
            do update set
                upc = case
                    when excluded.upc <> '' then excluded.upc
                    else item_catalog.upc
                end,
                description = case
                    when excluded.description <> '' then excluded.description
                    else item_catalog.description
                end,
                tracking_level = case
                    when excluded.tracking_level <> '' then excluded.tracking_level
                    else item_catalog.tracking_level
                end,
                units_per_case = coalesce(excluded.units_per_case, item_catalog.units_per_case),
                each_length = coalesce(excluded.each_length, item_catalog.each_length),
                each_width = coalesce(excluded.each_width, item_catalog.each_width),
                each_height = coalesce(excluded.each_height, item_catalog.each_height),
                image_url = case
                    when excluded.image_url <> '' then excluded.image_url
                    else item_catalog.image_url
                end,
                case_length = coalesce(excluded.case_length, item_catalog.case_length),
                case_width = coalesce(excluded.case_width, item_catalog.case_width),
                case_height = coalesce(excluded.case_height, item_catalog.case_height),
                updated_at = now()
        `,
        [
            entry.accountName,
            entry.sku,
            entry.upc,
            entry.description,
            entry.trackingLevel,
            entry.unitsPerCase,
            entry.eachLength,
            entry.eachWidth,
            entry.eachHeight,
            entry.imageUrl,
            entry.caseLength,
            entry.caseWidth,
            entry.caseHeight
        ]
    );
}

async function replaceItemMaster(client, item) {
    const entry = sanitizeItemMasterInput(item);
    if (!entry || !entry.accountName || !entry.sku) return;

    await client.query(
        `
            insert into item_catalog (
                account_name, sku, upc, description, tracking_level, units_per_case,
                each_length, each_width, each_height, image_url,
                case_length, case_width, case_height
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            on conflict (account_name, sku)
            do update set
                upc = excluded.upc,
                description = excluded.description,
                tracking_level = excluded.tracking_level,
                units_per_case = excluded.units_per_case,
                each_length = excluded.each_length,
                each_width = excluded.each_width,
                each_height = excluded.each_height,
                image_url = excluded.image_url,
                case_length = excluded.case_length,
                case_width = excluded.case_width,
                case_height = excluded.case_height,
                updated_at = now()
        `,
        [
            entry.accountName,
            entry.sku,
            entry.upc,
            entry.description,
            entry.trackingLevel,
            entry.unitsPerCase,
            entry.eachLength,
            entry.eachWidth,
            entry.eachHeight,
            entry.imageUrl,
            entry.caseLength,
            entry.caseWidth,
            entry.caseHeight
        ]
    );
}

async function updateItemMasterAndInventory(client, originalAccountName, originalSku, item) {
    const normalizedAccountName = normalizeText(originalAccountName);
    const normalizedOriginalSku = normalizeText(originalSku);
    const currentMaster = await findCatalogItem(client, normalizedAccountName, normalizedOriginalSku);
    const originalLines = await client.query(
        "select * from inventory_lines where account_name = $1 and sku = $2 order by location asc, id asc",
        [normalizedAccountName, normalizedOriginalSku]
    );

    if (!currentMaster && !originalLines.rowCount) {
        throw httpError(404, "That saved item could not be found.");
    }

    const mergedEntry = sanitizeItemMasterInput({
        accountName: normalizedAccountName,
        sku: item.sku,
        upc: item.upc,
        description: item.description,
        trackingLevel: item.trackingLevel,
        unitsPerCase: item.unitsPerCase,
        eachLength: item.eachLength,
        eachWidth: item.eachWidth,
        eachHeight: item.eachHeight,
        imageUrl: item.imageUrl,
        caseLength: item.caseLength,
        caseWidth: item.caseWidth,
        caseHeight: item.caseHeight
    });

    if (!mergedEntry || !mergedEntry.accountName || !mergedEntry.sku) {
        throw httpError(400, "Vendor / Customer and SKU are required.");
    }

    const targetMaster = mergedEntry.sku !== normalizedOriginalSku
        ? await findCatalogItem(client, normalizedAccountName, mergedEntry.sku)
        : null;
    const finalEntry = targetMaster
        ? sanitizeItemMasterInput({
            accountName: normalizedAccountName,
            sku: mergedEntry.sku,
            upc: mergedEntry.upc || targetMaster.upc || "",
            description: mergedEntry.description || targetMaster.description || "",
            trackingLevel: mergedEntry.trackingLevel || targetMaster.trackingLevel || "UNIT",
            unitsPerCase: mergedEntry.unitsPerCase ?? targetMaster.unitsPerCase ?? null,
            eachLength: mergedEntry.eachLength ?? targetMaster.eachLength ?? null,
            eachWidth: mergedEntry.eachWidth ?? targetMaster.eachWidth ?? null,
            eachHeight: mergedEntry.eachHeight ?? targetMaster.eachHeight ?? null,
            imageUrl: mergedEntry.imageUrl || targetMaster.imageUrl || "",
            caseLength: mergedEntry.caseLength ?? targetMaster.caseLength ?? null,
            caseWidth: mergedEntry.caseWidth ?? targetMaster.caseWidth ?? null,
            caseHeight: mergedEntry.caseHeight ?? targetMaster.caseHeight ?? null
        })
        : mergedEntry;

    const targetUpc = finalEntry.upc || "";
    const targetTrackingLevel = finalEntry.trackingLevel || "UNIT";

    if (finalEntry.sku === normalizedOriginalSku) {
        await client.query(
            `
                update inventory_lines
                set
                    upc = $3,
                    tracking_level = $4,
                    updated_at = now()
                where account_name = $1 and sku = $2
            `,
            [normalizedAccountName, normalizedOriginalSku, targetUpc, targetTrackingLevel]
        );
    } else {
        const targetLines = await client.query(
            "select * from inventory_lines where account_name = $1 and sku = $2 order by location asc, id asc",
            [normalizedAccountName, finalEntry.sku]
        );
        const targetByLocation = new Map(targetLines.rows.map((row) => [row.location, row]));

        for (const line of originalLines.rows) {
            const existingTarget = targetByLocation.get(line.location);
            if (existingTarget) {
                await client.query(
                    `
                        update inventory_lines
                        set
                            quantity = $1,
                            upc = $2,
                            tracking_level = $3,
                            updated_at = now()
                        where id = $4
                    `,
                    [
                        Number(existingTarget.quantity) + Number(line.quantity),
                        targetUpc,
                        targetTrackingLevel,
                        existingTarget.id
                    ]
                );
                await client.query("delete from inventory_lines where id = $1", [line.id]);
            } else {
                await client.query(
                    `
                        update inventory_lines
                        set
                            sku = $1,
                            upc = $2,
                            tracking_level = $3,
                            updated_at = now()
                        where id = $4
                    `,
                    [
                        finalEntry.sku,
                        targetUpc,
                        targetTrackingLevel,
                        line.id
                    ]
                );
            }
        }
    }

    await replaceItemMaster(client, finalEntry);

    if (normalizedOriginalSku !== finalEntry.sku) {
        await client.query(
            "delete from item_catalog where account_name = $1 and sku = $2",
            [normalizedAccountName, normalizedOriginalSku]
        );
    }

    return finalEntry;
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

async function findInventoryLine(client, accountName, location, skuOrUpc) {
    const skuMatch = await client.query(
        "select * from inventory_lines where account_name = $1 and location = $2 and sku = $3 limit 1",
        [accountName, location, skuOrUpc]
    );
    if (skuMatch.rowCount === 1) {
        return skuMatch.rows[0];
    }

    const upcMatches = await client.query(
        "select * from inventory_lines where account_name = $1 and location = $2 and upc = $3 order by sku asc limit 2",
        [accountName, location, skuOrUpc]
    );

    if (upcMatches.rowCount > 1) {
        throw httpError(400, "Multiple items matched that UPC for the selected vendor/customer and location. Use the SKU instead.");
    }

    return upcMatches.rowCount === 1 ? upcMatches.rows[0] : null;
}

async function assertLocationCompatibleForOwner(client, accountName, location) {
    const conflicts = await client.query(
        `
            select distinct account_name
            from inventory_lines
            where location = $1 and account_name <> $2
            order by account_name asc
            limit 5
        `,
        [location, accountName]
    );

    if (conflicts.rowCount > 0) {
        const conflictNames = conflicts.rows.map((row) => row.account_name).filter(Boolean);
        throw httpError(
            400,
            `Location ${location} already contains another vendor/customer${conflictNames.length ? `: ${conflictNames.join(", ")}` : ""}. Mixed-owner locations are not allowed.`
        );
    }
}

async function findCatalogItem(client, accountName, sku, upc = "") {
    const normalizedAccount = normalizeText(accountName);
    const normalizedSku = normalizeText(sku);
    const normalizedUpc = normalizeText(upc);

    if (normalizedAccount && normalizedSku) {
        const skuMatch = await client.query(
            "select * from item_catalog where account_name = $1 and sku = $2 limit 1",
            [normalizedAccount, normalizedSku]
        );
        if (skuMatch.rowCount === 1) {
            return mapItemMasterRow(skuMatch.rows[0]);
        }
    }

    if (normalizedAccount && normalizedUpc) {
        const upcMatches = await client.query(
            "select * from item_catalog where account_name = $1 and upc = $2 order by sku asc limit 2",
            [normalizedAccount, normalizedUpc]
        );
        if (upcMatches.rowCount > 1) {
            throw httpError(400, "Multiple item masters matched that UPC for the selected vendor/customer. Use the SKU instead.");
        }
        if (upcMatches.rowCount === 1) {
            return mapItemMasterRow(upcMatches.rows[0]);
        }
    }

    return null;
}

function groupInventoryInputs(lines) {
    const grouped = new Map();
    for (const rawLine of lines) {
        const line = sanitizeInventoryLineInput(rawLine);
        if (!line) {
            throw httpError(400, "Each batch line must include vendor/customer, location, SKU, and positive quantity.");
        }
        const key = `${line.accountName}::${line.location}::${line.sku}`;
        const current = grouped.get(key) || {
            accountName: line.accountName,
            location: line.location,
            sku: line.sku,
            upc: line.upc,
            trackingLevel: line.trackingLevel,
            quantity: 0,
            description: "",
            imageUrl: ""
        };
        current.quantity += line.quantity;
        if (!current.upc && line.upc) current.upc = line.upc;
        current.trackingLevel = line.trackingLevel || current.trackingLevel || "UNIT";
        if (!current.description && line.description) current.description = line.description;
        if (!current.imageUrl && line.imageUrl) current.imageUrl = line.imageUrl;
        grouped.set(key, current);
    }
    return [...grouped.values()];
}

function sanitizeInventoryLineInput(line) {
    const accountName = normalizeText(line?.accountName || line?.owner || line?.vendor || line?.customer || LEGACY_ACCOUNT);
    const location = normalizeText(line?.location);
    const sku = normalizeText(line?.sku);
    const upc = normalizeText(line?.upc || "");
    const quantity = toPositiveInt(line?.quantity);
    const trackingLevel = normalizeTrackingLevel(line?.trackingLevel);
    if (!accountName || !location || !sku || !quantity) return null;
    return {
        accountName,
        location,
        sku,
        upc,
        trackingLevel,
        quantity,
        description: normalizeFreeText(line?.description),
        imageUrl: normalizeImageReference(line?.imageUrl || line?.image || line?.photoUrl || line?.image_url || ""),
        createdAt: typeof line?.createdAt === "string" ? line.createdAt : new Date().toISOString(),
        updatedAt: typeof line?.updatedAt === "string" ? line.updatedAt : new Date().toISOString()
    };
}

function groupLocationMasterInputs(items) {
    const grouped = new Map();
    for (const rawItem of items) {
        const item = sanitizeLocationMasterInput(rawItem);
        if (!item) {
            throw httpError(400, "Each BIN row must include a location code.");
        }
        const current = grouped.get(item.code) || { code: item.code, note: "" };
        if (!current.note && item.note) current.note = item.note;
        grouped.set(item.code, current);
    }
    return [...grouped.values()];
}

function groupItemMasterInputs(items) {
    const grouped = new Map();
    for (const rawItem of items) {
        const item = sanitizeItemMasterInput(rawItem);
        if (!item || !item.accountName || !item.sku) {
            throw httpError(400, "Each item row must include Vendor / Customer and SKU.");
        }

        const key = `${item.accountName}::${item.sku}`;
        const current = grouped.get(key) || {
            accountName: item.accountName,
            sku: item.sku,
            upc: "",
            description: "",
            trackingLevel: "UNIT",
            unitsPerCase: null,
            eachLength: null,
            eachWidth: null,
            eachHeight: null,
            imageUrl: "",
            caseLength: null,
            caseWidth: null,
            caseHeight: null
        };

        if (!current.upc && item.upc) current.upc = item.upc;
        if (!current.description && item.description) current.description = item.description;
        if ((current.trackingLevel === "UNIT" || !current.trackingLevel) && item.trackingLevel) current.trackingLevel = item.trackingLevel;
        if (!current.unitsPerCase && item.unitsPerCase) current.unitsPerCase = item.unitsPerCase;
        if (!current.eachLength && item.eachLength) current.eachLength = item.eachLength;
        if (!current.eachWidth && item.eachWidth) current.eachWidth = item.eachWidth;
        if (!current.eachHeight && item.eachHeight) current.eachHeight = item.eachHeight;
        if (!current.imageUrl && item.imageUrl) current.imageUrl = item.imageUrl;
        if (!current.caseLength && item.caseLength) current.caseLength = item.caseLength;
        if (!current.caseWidth && item.caseWidth) current.caseWidth = item.caseWidth;
        if (!current.caseHeight && item.caseHeight) current.caseHeight = item.caseHeight;

        grouped.set(key, current);
    }
    return [...grouped.values()];
}

function sanitizeLocationMasterInput(item) {
    const code = normalizeText(item?.code ?? item?.location);
    if (!code) return null;
    return {
        code,
        note: normalizeFreeText(item?.note),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function sanitizeOwnerMasterInput(item) {
    const value = typeof item === "string" ? item : item?.name ?? item?.owner ?? item?.vendor ?? item?.customer;
    const name = normalizeText(value);
    if (!name) return null;
    return {
        name,
        note: normalizeFreeText(typeof item === "string" ? "" : item?.note),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function sanitizeItemMasterInput(item) {
    const accountName = normalizeText(item?.accountName || item?.owner || item?.vendor || item?.customer || "");
    const sku = normalizeText(item?.sku);
    if (!sku) return null;
    return {
        accountName,
        sku,
        upc: normalizeText(item?.upc || ""),
        description: normalizeFreeText(item?.description),
        trackingLevel: normalizeTrackingLevel(item?.trackingLevel),
        unitsPerCase: toPositiveInt(item?.unitsPerCase),
        eachLength: toPositiveNumber(item?.eachLength),
        eachWidth: toPositiveNumber(item?.eachWidth),
        eachHeight: toPositiveNumber(item?.eachHeight),
        imageUrl: normalizeImageReference(item?.imageUrl || item?.image || item?.photoUrl || item?.image_url || ""),
        caseLength: toPositiveNumber(item?.caseLength),
        caseWidth: toPositiveNumber(item?.caseWidth),
        caseHeight: toPositiveNumber(item?.caseHeight),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
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
        accountName: row.account_name,
        location: row.location,
        sku: row.sku,
        upc: row.upc || "",
        trackingLevel: normalizeTrackingLevel(row.tracking_level),
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

function mapLocationMasterRow(row) {
    return {
        id: String(row.id),
        code: row.code,
        note: row.note || "",
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapOwnerMasterRow(row) {
    return {
        id: String(row.id),
        name: row.name,
        note: row.note || "",
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapItemMasterRow(row) {
    return {
        id: String(row.id),
        accountName: row.account_name,
        sku: row.sku,
        upc: row.upc || "",
        description: row.description || "",
        trackingLevel: normalizeTrackingLevel(row.tracking_level),
        unitsPerCase: row.units_per_case == null ? null : Number(row.units_per_case),
        eachLength: toNullableNumber(row.each_length),
        eachWidth: toNullableNumber(row.each_width),
        eachHeight: toNullableNumber(row.each_height),
        imageUrl: row.image_url || "",
        caseLength: toNullableNumber(row.case_length),
        caseWidth: toNullableNumber(row.case_width),
        caseHeight: toNullableNumber(row.case_height),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeFreeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTrackingLevel(value) {
    const normalized = normalizeText(value || "UNIT");
    if (normalized === "PALLET" || normalized === "PALLETS") return "PALLET";
    if (normalized === "CASE" || normalized === "CASES") return "CASE";
    return "UNIT";
}

function toPositiveInt(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toPositiveNumber(value) {
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toNullableNumber(value) {
    return value == null ? null : Number(value);
}

function normalizeImageReference(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return "";
    if (/^data:image\//i.test(text)) return text;

    const driveId = extractDriveFileId(text);
    if (driveId) {
        return `https://drive.google.com/thumbnail?id=${driveId}&sz=w1600`;
    }
    return text;
}

function extractDriveFileId(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return "";
    const match = text.match(/\/file\/d\/([A-Za-z0-9_-]+)/)
        || text.match(/[?&]id=([A-Za-z0-9_-]+)/)
        || text.match(/\/thumbnail\?id=([A-Za-z0-9_-]+)/);
    return match ? match[1] : "";
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

function formatTrackedQuantity(value, trackingLevel) {
    const normalized = normalizeTrackingLevel(trackingLevel);
    const noun = normalized === "PALLET" ? "pallet" : (normalized === "CASE" ? "case" : "unit");
    return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function formatTrackedSummaryFromItems(items) {
    const totals = { UNIT: 0, CASE: 0, PALLET: 0 };
    items.forEach((item) => {
        totals[normalizeTrackingLevel(item.trackingLevel)] += Number(item.quantity) || 0;
    });
    return formatTrackedSummary(totals);
}

function formatTrackedSummaryFromRows(rows) {
    const totals = { UNIT: 0, CASE: 0, PALLET: 0 };
    rows.forEach((row) => {
        totals[normalizeTrackingLevel(row.tracking_level || row.trackingLevel)] += Number(row.quantity) || 0;
    });
    return formatTrackedSummary(totals);
}

function formatTrackedSummary(totals) {
    const parts = [];
    if (totals.UNIT) parts.push(formatTrackedQuantity(totals.UNIT, "UNIT"));
    if (totals.CASE) parts.push(formatTrackedQuantity(totals.CASE, "CASE"));
    if (totals.PALLET) parts.push(formatTrackedQuantity(totals.PALLET, "PALLET"));
    return parts.join(" | ") || "0 qty";
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
