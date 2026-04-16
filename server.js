const crypto = require("crypto");
const express = require("express");
const path = require("path");
const { Pool } = require("pg");


function normalizeDateInput(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
}


function bootstrapNormalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function bootstrapNormalizeFreeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}


const normalizeEmail = bootstrapNormalizeEmail;
const normalizeFreeText = bootstrapNormalizeFreeText;

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ROOT_DIR = __dirname;
const DATABASE_URL = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || '';
const LEGACY_ACCOUNT = "LEGACY";
const PORTAL_SESSION_COOKIE = "wms365_portal_session";
const APP_SESSION_COOKIE = "wms365_app_session";
const PORTAL_SESSION_TTL_DAYS = 14;
const APP_SESSION_TTL_DAYS = 14;
const PORTAL_SESSION_MAX_AGE = PORTAL_SESSION_TTL_DAYS * 24 * 60 * 60;
const APP_SESSION_MAX_AGE = APP_SESSION_TTL_DAYS * 24 * 60 * 60;
const DEFAULT_ADMIN_EMAIL = bootstrapNormalizeEmail(process.env.APP_ADMIN_EMAIL || "admin@wms365.local");
const DEFAULT_ADMIN_PASSWORD = String(process.env.APP_ADMIN_PASSWORD || "ChangeMeNow123!");
const DEFAULT_ADMIN_NAME = bootstrapNormalizeFreeText(process.env.APP_ADMIN_NAME || "Platform Owner");
const ACTIVE_PORTAL_ORDER_STATUSES = ["RELEASED", "PICKED", "STAGED"];
const BILLING_FEE_SEED = [
    { code: "STANDARD_PALLET_STORAGE", category: "Storage", name: "Standard pallet storage (48 x 40 x standard height)", unitLabel: "per pallet per month", defaultRate: 0 },
    { code: "OVERSIZED_PALLET_STORAGE", category: "Storage", name: "Oversized pallet storage (48 x 40 x tall height)", unitLabel: "per pallet per month", defaultRate: 0 },
    { code: "CLIMATE_STANDARD_PALLET_STORAGE", category: "Storage", name: "Climate controlled pallet storage (standard size)", unitLabel: "per pallet per month", defaultRate: 0 },
    { code: "CLIMATE_OVERSIZED_PALLET_STORAGE", category: "Storage", name: "Climate controlled pallet storage (oversized)", unitLabel: "per pallet per month", defaultRate: 0 },
    { code: "FLOOR_STORAGE", category: "Storage", name: "Floor storage", unitLabel: "per floor position per month", defaultRate: 0 },
    { code: "NON_STACKABLE_PALLET_SURCHARGE", category: "Storage", name: "Non-stackable pallet surcharge", unitLabel: "per pallet", defaultRate: 0 },
    { code: "PEAK_PALLET_BILLING_ADJUSTMENT", category: "Storage", name: "Peak pallet billing adjustment", unitLabel: "per pallet", defaultRate: 0 },

    { code: "PALLET_RECEIVING_FEE", category: "Receiving / Inbound Handling", name: "Pallet receiving fee", unitLabel: "per pallet", defaultRate: 0 },
    { code: "CARTON_RECEIVING_FEE", category: "Receiving / Inbound Handling", name: "Carton receiving fee", unitLabel: "per carton", defaultRate: 0 },
    { code: "CONTAINER_UNLOADING_20", category: "Receiving / Inbound Handling", name: "Container unloading 20' container", unitLabel: "per container", defaultRate: 0 },
    { code: "CONTAINER_UNLOADING_40", category: "Receiving / Inbound Handling", name: "Container unloading 40' container", unitLabel: "per container", defaultRate: 0 },
    { code: "CONTAINER_UNLOADING_40HC", category: "Receiving / Inbound Handling", name: "Container unloading 40' high cube container", unitLabel: "per container", defaultRate: 0 },
    { code: "SLIP_SHEET_PALLET_UNLOADING", category: "Receiving / Inbound Handling", name: "Slip sheet pallet unloading", unitLabel: "per pallet", defaultRate: 0 },
    { code: "MANUAL_FLOOR_UNLOAD", category: "Receiving / Inbound Handling", name: "Manual floor unload (non-palletized cargo)", unitLabel: "per hour", defaultRate: 0 },
    { code: "APPOINTMENT_SCHEDULING", category: "Receiving / Inbound Handling", name: "Appointment scheduling / dock coordination", unitLabel: "per shipment", defaultRate: 0 },
    { code: "INSPECTION_COUNT_VERIFICATION", category: "Receiving / Inbound Handling", name: "Inspection and count verification", unitLabel: "per shipment", defaultRate: 0 },

    { code: "PUT_AWAY_PALLET", category: "Put Away", name: "Put-away fee", unitLabel: "per pallet", defaultRate: 0 },
    { code: "PUT_AWAY_CARTON", category: "Put Away", name: "Put-away fee", unitLabel: "per carton", defaultRate: 0 },
    { code: "PALLET_RESTACKING", category: "Put Away", name: "Pallet re-stacking or pallet correction", unitLabel: "per pallet", defaultRate: 0 },

    { code: "ORDER_PROCESSING_FIRST_ITEM", category: "Order Fulfillment – B2C", name: "Order processing fee (first item)", unitLabel: "per order", defaultRate: 0 },
    { code: "ADDITIONAL_ITEM_PICK", category: "Order Fulfillment – B2C", name: "Additional item pick fee", unitLabel: "per item", defaultRate: 0 },
    { code: "INSERT_MARKETING_MATERIAL", category: "Order Fulfillment – B2C", name: "Insert / marketing material insertion", unitLabel: "per order", defaultRate: 0 },
    { code: "KITTING_BUNDLING", category: "Order Fulfillment – B2C", name: "Kitting / bundling", unitLabel: "per unit", defaultRate: 0 },
    { code: "GIFT_WRAP_SPECIAL_PACKAGING", category: "Order Fulfillment – B2C", name: "Gift wrap or special packaging", unitLabel: "per order", defaultRate: 0 },

    { code: "CARTON_PICK_FEE", category: "Order Fulfillment – B2B", name: "Carton pick fee", unitLabel: "per carton", defaultRate: 0 },
    { code: "PALLET_PICK_FEE", category: "Order Fulfillment – B2B", name: "Pallet pick fee", unitLabel: "per pallet", defaultRate: 0 },
    { code: "ADDITIONAL_CARTON_PICK_FEE", category: "Order Fulfillment – B2B", name: "Additional carton pick fee", unitLabel: "per carton", defaultRate: 0 },
    { code: "MIXED_SKU_PALLET_BUILD", category: "Order Fulfillment – B2B", name: "Mixed SKU pallet build fee", unitLabel: "per pallet", defaultRate: 0 },
    { code: "RETAIL_COMPLIANCE_PREPARATION", category: "Order Fulfillment – B2B", name: "Retail compliance preparation", unitLabel: "per order", defaultRate: 0 },

    { code: "SHIPPING_LABEL_PRINTING", category: "Shipping & Handling", name: "Shipping label printing", unitLabel: "per label", defaultRate: 0 },
    { code: "CARTON_LABEL_APPLICATION", category: "Shipping & Handling", name: "Carton label application", unitLabel: "per carton", defaultRate: 0 },
    { code: "PALLET_LABEL_APPLICATION", category: "Shipping & Handling", name: "Pallet label application", unitLabel: "per pallet", defaultRate: 0 },
    { code: "BILL_OF_LADING_PREPARATION", category: "Shipping & Handling", name: "Bill of lading preparation", unitLabel: "per shipment", defaultRate: 0 },
    { code: "CARRIER_BOOKING_COORDINATION", category: "Shipping & Handling", name: "Carrier booking coordination", unitLabel: "per shipment", defaultRate: 0 },
    { code: "SHIPPING_ADMINISTRATION_FEE", category: "Shipping & Handling", name: "Shipping administration fee", unitLabel: "per shipment", defaultRate: 0 },
    { code: "FREIGHT_COST_MARKUP_PERCENTAGE", category: "Shipping & Handling", name: "Freight cost markup percentage", unitLabel: "percent", defaultRate: 0 },

    { code: "PRODUCT_LABELING", category: "Value Added Services", name: "Product labeling (UPC, FNSKU, barcode)", unitLabel: "per unit", defaultRate: 0 },
    { code: "POLY_BAGGING", category: "Value Added Services", name: "Poly bagging", unitLabel: "per unit", defaultRate: 0 },
    { code: "BUBBLE_WRAP_PROTECTIVE_PACKAGING", category: "Value Added Services", name: "Bubble wrap / protective packaging", unitLabel: "per unit", defaultRate: 0 },
    { code: "REPACKAGING", category: "Value Added Services", name: "Repackaging", unitLabel: "per unit", defaultRate: 0 },
    { code: "ASSEMBLY_LIGHT_MANUFACTURING", category: "Value Added Services", name: "Assembly / light manufacturing", unitLabel: "per unit", defaultRate: 0 },
    { code: "PRODUCT_INSPECTION", category: "Value Added Services", name: "Product inspection", unitLabel: "per unit", defaultRate: 0 },
    { code: "SORTING_SEGREGATION", category: "Value Added Services", name: "Sorting or segregation", unitLabel: "per hour", defaultRate: 0 },
    { code: "EXPIRY_DATE_VERIFICATION", category: "Value Added Services", name: "Expiry date verification", unitLabel: "per SKU", defaultRate: 0 },
    { code: "LOT_TRACKING_SETUP", category: "Value Added Services", name: "Lot tracking or batch tracking setup", unitLabel: "per setup", defaultRate: 0 },

    { code: "RETURN_RECEIVING", category: "Returns Processing", name: "Return receiving", unitLabel: "per unit", defaultRate: 0 },
    { code: "RETURN_INSPECTION", category: "Returns Processing", name: "Return inspection", unitLabel: "per unit", defaultRate: 0 },
    { code: "RESTOCKING_FEE", category: "Returns Processing", name: "Restocking fee", unitLabel: "per unit", defaultRate: 0 },
    { code: "DISPOSAL_FEE", category: "Returns Processing", name: "Disposal fee", unitLabel: "per unit or per pallet", defaultRate: 0 },
    { code: "REFURBISH_REPACKAGE", category: "Returns Processing", name: "Refurbish or repackage", unitLabel: "per unit", defaultRate: 0 },

    { code: "INVENTORY_CYCLE_COUNT", category: "Inventory Management", name: "Inventory cycle count", unitLabel: "per hour", defaultRate: 0 },
    { code: "FULL_INVENTORY_COUNT", category: "Inventory Management", name: "Full inventory count", unitLabel: "per SKU", defaultRate: 0 },
    { code: "INVENTORY_ADJUSTMENT_INVESTIGATION", category: "Inventory Management", name: "Inventory adjustment investigation", unitLabel: "per hour", defaultRate: 0 },
    { code: "INVENTORY_REPORTING_CUSTOMIZATION", category: "Inventory Management", name: "Inventory reporting customization", unitLabel: "per setup", defaultRate: 0 },

    { code: "CROSS_DOCK_PALLET_HANDLING", category: "Cross Dock Services", name: "Cross dock pallet handling", unitLabel: "per pallet", defaultRate: 0 },
    { code: "CROSS_DOCK_CARTON_HANDLING", category: "Cross Dock Services", name: "Cross dock carton handling", unitLabel: "per carton", defaultRate: 0 },
    { code: "SHORT_TERM_STAGING_FEE", category: "Cross Dock Services", name: "Short-term staging fee", unitLabel: "per pallet per day", defaultRate: 0 },
    { code: "PALLET_TRANSFER_INBOUND_OUTBOUND", category: "Cross Dock Services", name: "Pallet transfer from inbound to outbound", unitLabel: "per pallet", defaultRate: 0 },

    { code: "GENERAL_LABOUR", category: "Labour & Equipment", name: "General labour", unitLabel: "per hour", defaultRate: 0 },
    { code: "FORKLIFT_USAGE", category: "Labour & Equipment", name: "Forklift usage", unitLabel: "per hour", defaultRate: 0 },
    { code: "SUPERVISOR_LABOUR", category: "Labour & Equipment", name: "Supervisor labour", unitLabel: "per hour", defaultRate: 0 },
    { code: "OVERTIME_LABOUR_MULTIPLIER", category: "Labour & Equipment", name: "Overtime labour multiplier", unitLabel: "multiplier", defaultRate: 0 },
    { code: "WEEKEND_OPENING_FEE", category: "Labour & Equipment", name: "Weekend opening fee", unitLabel: "per opening", defaultRate: 0 },

    { code: "STANDARD_PALLET_SUPPLY", category: "Packaging Materials", name: "Standard pallet supply", unitLabel: "per pallet", defaultRate: 0 },
    { code: "HEAT_TREATED_PALLET_SUPPLY", category: "Packaging Materials", name: "Heat treated pallet supply", unitLabel: "per pallet", defaultRate: 0 },
    { code: "SHRINK_WRAP", category: "Packaging Materials", name: "Shrink wrap", unitLabel: "per pallet", defaultRate: 0 },
    { code: "CORNER_BOARDS", category: "Packaging Materials", name: "Corner boards", unitLabel: "per pallet", defaultRate: 0 },
    { code: "TAPE", category: "Packaging Materials", name: "Tape", unitLabel: "per carton", defaultRate: 0 },
    { code: "VOID_FILL_MATERIAL", category: "Packaging Materials", name: "Void fill material", unitLabel: "per carton", defaultRate: 0 },

    { code: "ACCOUNT_SETUP_FEE", category: "Administrative Fees", name: "Account setup fee", unitLabel: "per account", defaultRate: 0 },
    { code: "SKU_SETUP_FEE", category: "Administrative Fees", name: "SKU setup fee", unitLabel: "per SKU", defaultRate: 0 },
    { code: "WMS_SYSTEM_ACCESS", category: "Administrative Fees", name: "WMS system access", unitLabel: "per user per month", defaultRate: 0 },
    { code: "EDI_INTEGRATION_SETUP", category: "Administrative Fees", name: "EDI integration setup", unitLabel: "per setup", defaultRate: 0 },
    { code: "CUSTOM_REPORTING_SETUP", category: "Administrative Fees", name: "Custom reporting setup", unitLabel: "per setup", defaultRate: 0 },
    { code: "RUSH_ORDER_SURCHARGE_PERCENTAGE", category: "Administrative Fees", name: "Rush order surcharge percentage", unitLabel: "percent", defaultRate: 0 },

    { code: "FOOD_GRADE_HANDLING_COMPLIANCE", category: "Compliance & Special Handling", name: "Food grade handling compliance", unitLabel: "per shipment", defaultRate: 0 },
    { code: "TEMPERATURE_MONITORING", category: "Compliance & Special Handling", name: "Temperature monitoring", unitLabel: "per day", defaultRate: 0 },
    { code: "LOT_CONTROL_HANDLING", category: "Compliance & Special Handling", name: "Lot control handling", unitLabel: "per SKU", defaultRate: 0 },
    { code: "FRAGILE_HANDLING_SURCHARGE", category: "Compliance & Special Handling", name: "Fragile handling surcharge", unitLabel: "per shipment", defaultRate: 0 },
    { code: "DANGEROUS_GOODS_HANDLING", category: "Compliance & Special Handling", name: "Dangerous goods handling (if applicable)", unitLabel: "per shipment", defaultRate: 0 },

    { code: "PALLET_BREAKDOWN", category: "Additional Services", name: "Pallet breakdown", unitLabel: "per pallet", defaultRate: 0 },
    { code: "PALLET_REBUILD", category: "Additional Services", name: "Pallet rebuild", unitLabel: "per pallet", defaultRate: 0 },
    { code: "RELABELING_COMPLIANCE_CHANGES", category: "Additional Services", name: "Relabeling due to compliance changes", unitLabel: "per unit", defaultRate: 0 },
    { code: "PRODUCT_RECALL_ASSISTANCE", category: "Additional Services", name: "Product recall assistance", unitLabel: "per hour", defaultRate: 0 },
    { code: "SPECIAL_PROJECT_WORK", category: "Additional Services", name: "Special project work", unitLabel: "per hour", defaultRate: 0 }
];

let databaseReady = false;
let databaseErrorMessage = "";
let databaseInitStartedAt = null;

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
    })
    : createUnavailablePool("DATABASE_URL or DATABASE_PRIVATE_URL is required. Add a PostgreSQL database in Railway and expose it to this service.");

if (!DATABASE_URL) {
    databaseErrorMessage = "DATABASE_URL or DATABASE_PRIVATE_URL is required. Add a PostgreSQL database in Railway and expose it to this service.";
    console.error(databaseErrorMessage);
}

pool.on("error", (error) => {
    databaseReady = false;
    databaseErrorMessage = error.message;
    console.error("Unexpected PostgreSQL pool error:", error);
});

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "12mb" }));

app.use(async (req, res, next) => {
    try {
        if (!requiresAppAuth(req)) {
            return next();
        }
        const session = await requireAppSession(req);
        req.appUser = session.user;
        req.appSessionId = session.sessionId;
        next();
    } catch (error) {
        if (error.statusCode === 401) {
            clearAppSessionCookie(res, req);
        }
        next(error);
    }
});

app.post("/api/app/login", async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        if (!email || !password) {
            throw httpError(400, "Email address and password are required.");
        }

        const session = await withTransaction(async (client) => {
            const user = await getAppUserByEmail(client, email);
            if (!user || !user.is_active) {
                throw httpError(401, "That warehouse login is not active.");
            }
            if (!verifyPortalPassword(password, user.password_hash)) {
                throw httpError(401, "The warehouse password was not accepted.");
            }
            const token = await createAppSession(client, user.id);
            await client.query("update app_users set last_login_at = now(), updated_at = now() where id = $1", [user.id]);
            return { token, user: await getAppUserById(client, user.id) };
        });

        setAppSessionCookie(res, session.token, req);
        res.json({ success: true, user: mapAppUserRow(session.user) });
    } catch (error) {
        next(error);
    }
});

app.post("/api/app/logout", async (req, res, next) => {
    try {
        const sessionToken = getAppSessionToken(req);
        if (sessionToken) {
            await deleteAppSessionByToken(sessionToken);
        }
        clearAppSessionCookie(res, req);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get("/api/app/me", async (req, res, next) => {
    try {
        const session = await requireAppSession(req);
        res.json({ authenticated: true, user: mapAppUserRow(session.user) });
    } catch (error) {
        if (error.statusCode === 401) {
            clearAppSessionCookie(res, req);
        }
        next(error);
    }
});

app.get("/api/health", (_req, res) => {
    res.status(200).json({
        ok: true,
        databaseReady,
        databaseError: databaseErrorMessage || null,
        startedInitializingAt: databaseInitStartedAt,
        requiresDatabase: true
    });
});

app.use((req, _res, next) => {
    if (!isPublicRequest(req)) {
        try {
            assertDatabaseAvailable();
        } catch (error) {
            return next(error);
        }
    }
    next();
});

app.get("/api/state", async (_req, res, next) => {
    try {
        res.json(await getServerState(pool, { billingEventLimit: 1000 }));
    } catch (error) {
        next(error);
    }
});

app.get("/api/export", async (_req, res, next) => {
    try {
        res.json({
            app: "WMS365 Scanner",
            exportedAt: new Date().toISOString(),
            ...(await getServerState(pool, { billingEventLimit: null }))
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
            throw httpError(400, "A company name is required.");
        }

        await withTransaction(async (client) => {
            await upsertOwnerMaster(client, entry);
            await insertActivity(
                client,
                "setup",
                `Saved company ${entry.name}`,
                [
                    entry.legalName ? `Legal ${entry.legalName}` : "",
                    entry.contactName ? `Contact ${entry.contactName}` : "",
                    entry.email ? `Email ${entry.email}` : "",
                    entry.portalLoginEmail ? `Portal ${entry.portalLoginEmail}` : "",
                    entry.note ? entry.note : "Company profile saved to the shared library."
                ].filter(Boolean).join(" | ")
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
            throw httpError(400, "Company and SKU are required.");
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
            throw httpError(400, "The original company and SKU are required to update an item.");
        }
        if (!entry || !entry.accountName || !entry.sku) {
            throw httpError(400, "Company and SKU are required.");
        }
        if (entry.accountName !== originalAccountName) {
            throw httpError(400, "Changing company from the item editor is not supported.");
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

app.post("/api/billing/rates", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.vendor || req.body?.customer);
        const rates = Array.isArray(req.body?.rates) ? req.body.rates : [];
        if (!accountName) {
            throw httpError(400, "Company is required.");
        }

        const savedRates = await withTransaction(async (client) => {
            await upsertOwnerMaster(client, accountName);
            await saveOwnerBillingRates(client, accountName, rates);
            await insertActivity(
                client,
                "billing",
                `Updated billing rates for ${accountName}`,
                `${formatCount(rates.length, "fee")} reviewed for warehouse billing.`
            );
            return getOwnerBillingRates(client, accountName);
        });

        res.json({ success: true, accountName, rates: savedRates });
    } catch (error) {
        next(error);
    }
});

app.post("/api/billing/events/manual", async (req, res, next) => {
    try {
        const entry = sanitizeManualBillingEventInput(req.body);
        if (!entry?.accountName || !entry?.feeCode || !entry?.quantity) {
            throw httpError(400, "Company, fee, and quantity are required.");
        }

        const billingEvent = await withTransaction(async (client) => {
            await upsertOwnerMaster(client, entry.accountName);
            const created = await createBillingEventForFee(client, entry.accountName, entry.feeCode, entry.quantity, {
                sourceType: "MANUAL",
                sourceRef: entry.reference || entry.note || `MANUAL-${Date.now()}`,
                description: entry.description,
                note: entry.note,
                reference: entry.reference,
                serviceDate: entry.serviceDate,
                eventKey: entry.eventKey || null,
                rateOverride: entry.rate
            });
            if (!created) {
                throw httpError(400, "That fee is disabled for this company. Enable it in the billing setup first.");
            }
            await insertActivity(
                client,
                "billing",
                `Added billing line for ${entry.accountName}`,
                `${created.feeName} | ${formatBillingQuantity(created.quantity)} @ ${formatMoney(created.rate)}`
            );
            return created;
        });

        res.json({ success: true, event: billingEvent });
    } catch (error) {
        next(error);
    }
});

app.post("/api/billing/storage-accrual", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.vendor || req.body?.customer);
        const month = normalizeBillingMonth(req.body?.month);
        if (!accountName || !month) {
            throw httpError(400, "Company and billing month are required.");
        }

        const events = await withTransaction(async (client) => {
            await upsertOwnerMaster(client, accountName);
            const created = await createMonthlyStorageBillingEvents(client, accountName, month);
            await insertActivity(
                client,
                "billing",
                `Generated storage billing for ${accountName}`,
                `${month} | ${formatCount(created.length, "line")} created or refreshed.`
            );
            return created;
        });

        res.json({ success: true, accountName, month, events });
    } catch (error) {
        next(error);
    }
});

app.post("/api/billing/events/mark-invoiced", async (req, res, next) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((value) => Number.parseInt(String(value), 10)).filter((value) => Number.isFinite(value) && value > 0) : [];
        const invoiceNumber = normalizeFreeText(req.body?.invoiceNumber);
        if (!ids.length) {
            throw httpError(400, "Choose at least one billing line first.");
        }
        if (!invoiceNumber) {
            throw httpError(400, "Invoice number is required.");
        }

        const updated = await withTransaction(async (client) => {
            const result = await client.query(
                `
                    update billing_events
                    set
                        status = 'INVOICED',
                        invoice_number = $2,
                        invoiced_at = now(),
                        updated_at = now()
                    where id = any($1::bigint[])
                      and status <> 'VOID'
                    returning *
                `,
                [ids, invoiceNumber]
            );
            await insertActivity(
                client,
                "billing",
                `Marked ${formatCount(result.rowCount, "billing line")} invoiced`,
                `Invoice ${invoiceNumber}`
            );
            return result.rows.map(mapBillingEventRow);
        });

        res.json({ success: true, events: updated });
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
        const billingContextItems = [];

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
                billingContextItems.push({
                    ...item,
                    unitsPerCase: master?.unitsPerCase ?? null
                });
            }

            const activity = await insertActivity(
                client,
                "scan",
                `Saved ${formatCount(items.length, "staged line")} to inventory`,
                `${formatCount(ownerCount, "owner")} | ${formatCount(locationCount, "location")} | ${formatTrackedSummaryFromItems(items)}`
            );
            await createBatchBillingEvents(client, billingContextItems, activity?.id ? `ACTIVITY-${activity.id}` : `BATCH-${Date.now()}`);
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
            throw httpError(400, "Company, location, SKU/UPC, and quantity are required.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, accountName, location, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that company, location, and SKU/UPC.");
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
            throw httpError(400, "Company, location, and SKU/UPC are required.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, accountName, location, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that company, location, and SKU/UPC.");
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
            throw httpError(400, "Company, from location, to location, SKU/UPC, and quantity are required.");
        }
        if (fromLocation === toLocation) {
            throw httpError(400, "Source and destination locations cannot be the same.");
        }

        await withTransaction(async (client) => {
            const line = await findInventoryLine(client, accountName, fromLocation, skuOrUpc);
            if (!line) {
                throw httpError(404, "No exact inventory line matched that company, source location, and SKU/UPC.");
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

app.post("/api/convert-item", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner);
        const fromLocation = normalizeText(req.body?.fromLocation);
        const toLocation = normalizeText(req.body?.toLocation || req.body?.targetLocation || req.body?.fromLocation);
        const fromSkuOrUpc = normalizeText(req.body?.fromSkuOrUpc || req.body?.sourceSkuOrUpc || req.body?.sourceSku);
        const toSkuOrUpc = normalizeText(req.body?.toSkuOrUpc || req.body?.targetSkuOrUpc || req.body?.targetSku);
        const sourceQuantity = toPositiveInt(req.body?.sourceQuantity || req.body?.quantity);

        if (!accountName || !fromLocation || !toLocation || !fromSkuOrUpc || !toSkuOrUpc || !sourceQuantity) {
            throw httpError(400, "Company, source location, destination location, source SKU/UPC, target SKU/UPC, and source quantity are required.");
        }

        const conversion = await withTransaction(async (client) => {
            const sourceLine = await findInventoryLine(client, accountName, fromLocation, fromSkuOrUpc);
            if (!sourceLine) {
                throw httpError(404, "No exact source inventory line matched that company, location, and SKU/UPC.");
            }
            if (sourceQuantity > Number(sourceLine.quantity)) {
                throw httpError(
                    400,
                    `Cannot convert ${formatTrackedQuantity(sourceQuantity, sourceLine.tracking_level)} because only ${formatTrackedQuantity(Number(sourceLine.quantity), sourceLine.tracking_level)} are available.`
                );
            }

            const sourceMaster = await findCatalogItem(client, accountName, sourceLine.sku, sourceLine.upc);
            const targetMaster = await findCatalogItem(client, accountName, toSkuOrUpc, toSkuOrUpc);
            if (!targetMaster) {
                throw httpError(404, "The target item could not be found in this company's item master.");
            }
            if (normalizeText(sourceLine.sku) === normalizeText(targetMaster.sku)) {
                throw httpError(400, "Source and target items must be different.");
            }

            await assertLocationCompatibleForOwner(client, accountName, toLocation);
            const plan = buildItemConversionPlan({
                accountName,
                fromLocation,
                toLocation,
                sourceLine,
                sourceMaster,
                targetMaster,
                sourceQuantity
            });

            await setInventoryQuantity(client, sourceLine.id, Number(sourceLine.quantity) - sourceQuantity);
            await upsertInventoryLine(client, {
                accountName,
                location: toLocation,
                sku: plan.targetSku,
                upc: plan.targetUpc,
                quantity: plan.targetQuantity,
                trackingLevel: plan.targetTrackingLevel
            });
            await upsertLocationMaster(client, fromLocation);
            await upsertLocationMaster(client, toLocation);
            await upsertItemMaster(client, {
                accountName,
                sku: plan.targetSku,
                upc: plan.targetUpc,
                description: plan.targetDescription,
                trackingLevel: plan.targetTrackingLevel,
                unitsPerCase: plan.targetUnitsPerCase
            });
            await insertActivity(
                client,
                "transfer",
                `Converted ${formatTrackedQuantity(sourceQuantity, plan.sourceTrackingLevel)} of ${accountName} / ${plan.sourceSku}`,
                `${fromLocation} -> ${toLocation} | ${formatTrackedQuantity(plan.targetQuantity, plan.targetTrackingLevel)} of ${plan.targetSku} created`
            );
            return plan;
        });

        res.json({ success: true, conversion });
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
            throw httpError(400, "Company, from location, and to location are required.");
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
        const importedPallets = Array.isArray(req.body?.pallets) ? req.body.pallets.map(sanitizePalletRecordInput).filter(Boolean) : [];
        const importedBillingFees = Array.isArray(req.body?.billing?.feeCatalog) ? req.body.billing.feeCatalog.map(sanitizeBillingFeeInput).filter(Boolean) : [];
        const importedOwnerRates = Array.isArray(req.body?.billing?.ownerRates) ? req.body.billing.ownerRates.map(sanitizeOwnerBillingRateInput).filter(Boolean) : [];
        const importedBillingEvents = Array.isArray(req.body?.billing?.events) ? req.body.billing.events.map(sanitizeBillingEventInput).filter(Boolean) : [];
        const importedLocations = Array.isArray(req.body?.masters?.locations) ? req.body.masters.locations.map(sanitizeLocationMasterInput).filter(Boolean) : [];
        const importedItems = Array.isArray(req.body?.masters?.items) ? req.body.masters.items.map(sanitizeItemMasterInput).filter(Boolean) : [];
        const importedOwners = Array.isArray(req.body?.masters?.ownerRecords)
            ? req.body.masters.ownerRecords.map(sanitizeOwnerMasterInput).filter(Boolean)
            : Array.isArray(req.body?.masters?.owners)
                ? req.body.masters.owners.map((owner) => sanitizeOwnerMasterInput(owner)).filter(Boolean)
                : [];

        await withTransaction(async (client) => {
            await client.query("truncate table activity_log, pallet_records, inventory_lines, billing_events, owner_billing_rates, bin_locations, item_catalog, owner_accounts restart identity cascade");

            if (importedBillingFees.length) {
                await client.query("truncate table billing_fee_catalog");
            }

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

            for (const pallet of importedPallets) {
                await client.query(
                    `
                        insert into pallet_records (
                            pallet_code, account_name, sku, upc, description,
                            cases_on_pallet, label_date, location,
                            inventory_tracking_level, inventory_quantity,
                            created_at, updated_at
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    `,
                    [
                        pallet.palletCode,
                        pallet.accountName,
                        pallet.sku,
                        pallet.upc,
                        pallet.description,
                        pallet.cases,
                        pallet.date,
                        pallet.location,
                        pallet.inventoryTrackingLevel,
                        pallet.inventoryQuantity,
                        pallet.createdAt,
                        pallet.updatedAt
                    ]
                );
            }

            for (const fee of importedBillingFees) {
                await client.query(
                    `
                        insert into billing_fee_catalog (
                            code, category, name, unit_label, default_rate, is_active, created_at, updated_at
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8)
                    `,
                    [fee.code, fee.category, fee.name, fee.unitLabel, fee.defaultRate, fee.isActive !== false, fee.createdAt, fee.updatedAt]
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

            for (const rate of importedOwnerRates) {
                await client.query(
                    `
                        insert into owner_billing_rates (
                            account_name, fee_code, rate, is_enabled, unit_label, note, created_at, updated_at
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8)
                    `,
                    [rate.accountName, rate.feeCode, rate.rate, rate.isEnabled === true, rate.unitLabel, rate.note, rate.createdAt, rate.updatedAt]
                );
            }

            for (const event of importedBillingEvents) {
                await client.query(
                    `
                        insert into billing_events (
                            event_key, account_name, fee_code, fee_category, fee_name, unit_label,
                            quantity, rate, amount, currency_code, service_date, status,
                            invoice_number, invoiced_at, source_type, source_ref, reference, note,
                            metadata, created_at, updated_at
                        )
                        values (
                            $1, $2, $3, $4, $5, $6,
                            $7, $8, $9, $10, $11, $12,
                            $13, $14, $15, $16, $17, $18,
                            $19, $20, $21
                        )
                    `,
                    [
                        event.eventKey,
                        event.accountName,
                        event.feeCode,
                        event.feeCategory,
                        event.feeName,
                        event.unitLabel,
                        event.quantity,
                        event.rate,
                        event.amount,
                        event.currencyCode,
                        event.serviceDate,
                        event.status,
                        event.invoiceNumber,
                        event.invoicedAt,
                        event.sourceType,
                        event.sourceRef,
                        event.reference,
                        event.note,
                        JSON.stringify(event.metadata || {}),
                        event.createdAt,
                        event.updatedAt
                    ]
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

            for (const pallet of importedPallets) {
                await upsertOwnerMaster(client, pallet.accountName);
                if (pallet.location) {
                    await upsertLocationMaster(client, pallet.location);
                }
                await upsertItemMaster(client, {
                    accountName: pallet.accountName,
                    sku: pallet.sku,
                    upc: pallet.upc,
                    description: pallet.description,
                    trackingLevel: pallet.inventoryTrackingLevel
                });
            }

            await insertActivity(
                client,
                "import",
                "Imported JSON backup",
                `${formatCount(importedInventory.length, "inventory line")} restored, ${formatCount(importedPallets.length, "pallet record")}, ${formatCount(importedBillingEvents.length, "billing line")}, plus ${formatCount(importedOwners.length, "owner")}, ${formatCount(importedLocations.length, "BIN")}, and ${formatCount(importedItems.length, "item master")}.`
            );
        });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get("/api/pallets/:palletCode", async (req, res, next) => {
    try {
        const palletCode = normalizeText(req.params?.palletCode);
        if (!palletCode) {
            throw httpError(400, "A pallet code is required.");
        }

        const pallet = await getPalletRecordByCode(pool, palletCode);
        if (!pallet) {
            throw httpError(404, `Pallet ${palletCode} could not be found.`);
        }

        res.json({ pallet });
    } catch (error) {
        next(error);
    }
});

app.post("/api/pallets/save", async (req, res, next) => {
    try {
        const entry = sanitizePalletRecordInput(req.body);
        if (!entry || !entry.accountName || !entry.sku || !entry.cases || !entry.date) {
            throw httpError(400, "Company, SKU, cases on pallet, and date are required.");
        }

        const pallet = await withTransaction(async (client) => {
            const saved = await savePalletRecord(client, entry);
            await insertActivity(
                client,
                "pallet",
                `${entry.palletCode ? "Updated" : "Saved"} pallet ${saved.palletCode}`,
                [
                    saved.accountName,
                    saved.sku,
                    saved.location ? `Location ${saved.location}` : "Unassigned",
                    formatTrackedQuantity(saved.inventoryQuantity, saved.inventoryTrackingLevel),
                    `${saved.cases} case${saved.cases === 1 ? "" : "s"} on pallet`
                ].join(" | ")
            );
            return saved;
        });

        res.json({ success: true, pallet });
    } catch (error) {
        next(error);
    }
});

app.get("/api/admin/portal-access", async (_req, res, next) => {
    try {
        res.json({
            access: await getPortalAccessList()
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/admin/portal-orders", async (req, res, next) => {
    try {
        const requestedAccount = normalizeText(req.query?.accountName || req.query?.account_name || "");
        const orders = requestedAccount
            ? await getPortalOrdersForAccount(requestedAccount)
            : await getAdminPortalOrders();
        res.json({ orders });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/portal-access", async (req, res, next) => {
    try {
        const accessId = typeof req.body?.accessId === "string" || typeof req.body?.accessId === "number"
            ? String(req.body.accessId).trim()
            : "";
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.vendor || req.body?.customer);
        const email = normalizeEmail(req.body?.email);
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const isActive = req.body?.isActive !== false;

        if (!accountName) {
            throw httpError(400, "Company is required.");
        }
        if (!email) {
            throw httpError(400, "A user email address is required.");
        }

        const savedAccess = await withTransaction(async (client) => {
            await upsertOwnerMaster(client, accountName);
            const access = await savePortalAccess(client, { accessId, accountName, email, password, isActive });
            await insertActivity(
                client,
                "setup",
                `${access.wasCreated ? "Added" : "Updated"} portal user ${email} for ${accountName}`,
                [
                    `Company ${accountName}.`,
                    isActive ? "Portal access active." : "Portal access disabled.",
                    password ? `Portal password ${access.wasCreated ? "created" : "reset"} by warehouse admin.` : "Portal user details updated."
                ].join(" ")
            );
            return access;
        });

        res.json({
            success: true,
            access: mapPortalAccessRow(savedAccess),
            wasCreated: savedAccess.wasCreated === true
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/portal/login", async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const password = typeof req.body?.password === "string" ? req.body.password : "";

        if (!email || !password) {
            throw httpError(400, "Email address and password are required.");
        }

        const access = await withTransaction(async (client) => {
            const vendorAccess = await getPortalAccessByEmail(client, email);
            if (!vendorAccess || !vendorAccess.is_active) {
                throw httpError(401, "That company portal login is not active.");
            }
            if (!verifyPortalPassword(password, vendorAccess.password_hash)) {
                throw httpError(401, "The company portal password was not accepted.");
            }

            const token = await createPortalSession(client, vendorAccess.id);
            await client.query("update portal_vendor_access set last_login_at = now(), updated_at = now() where id = $1", [vendorAccess.id]);
            return {
                token,
                access: await getPortalAccessById(client, vendorAccess.id)
            };
        });

        setPortalSessionCookie(res, access.token, req);
        res.json({
            success: true,
            account: mapPortalAccessRow(access.access)
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/portal/logout", async (req, res, next) => {
    try {
        const sessionToken = getPortalSessionToken(req);
        if (sessionToken) {
            await deletePortalSessionByToken(sessionToken);
        }
        clearPortalSessionCookie(res, req);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get("/api/portal/me", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        res.json({
            authenticated: true,
            account: session.access
        });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.get("/api/portal/inventory", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        res.json({
            inventory: await getPortalInventorySummary(session.access.accountName)
        });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.get("/api/portal/orders", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        res.json({
            orders: await getPortalOrdersForAccount(session.access.accountName)
        });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.get("/api/portal/inbounds", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        const inbounds = await getPortalInboundsForAccount(session.access.accountName);
        res.json({ inbounds });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.post("/api/portal/inbounds", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        const inbound = await withTransaction((client) => savePortalInbound(client, session.accessRow, req.body));
        res.status(201).json({ success: true, inbound });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.get("/api/portal/items", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        res.json({
            items: await getPortalItemsForAccount(session.access.accountName)
        });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.post("/api/portal/orders", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        const order = await withTransaction(async (client) => savePortalOrderDraft(client, session.accessRow, req.body));
        res.json({ success: true, order });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.put("/api/portal/orders/:id", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        const orderId = toPositiveInt(req.params.id);
        if (!orderId) {
            throw httpError(400, "A valid order id is required.");
        }
        const order = await withTransaction(async (client) => savePortalOrderDraft(client, session.accessRow, req.body, orderId));
        res.json({ success: true, order });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.post("/api/portal/orders/:id/release", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        const orderId = toPositiveInt(req.params.id);
        if (!orderId) {
            throw httpError(400, "A valid order id is required.");
        }
        const order = await withTransaction(async (client) => releasePortalOrder(client, session.accessRow, orderId));
        res.json({ success: true, order });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.post("/api/admin/portal-orders/:id/status", async (req, res, next) => {
    try {
        const orderId = toPositiveInt(req.params.id);
        const nextStatus = normalizePortalOrderStatus(req.body?.status);
        if (!orderId) {
            throw httpError(400, "A valid order id is required.");
        }
        if (!nextStatus) {
            throw httpError(400, "A valid order status is required.");
        }

        const order = await withTransaction(async (client) => {
            return updateAdminPortalOrderStatus(client, orderId, nextStatus, req.body, req.appUser);
        });

        res.json({ success: true, order });
    } catch (error) {
        next(error);
    }
});

app.get("/api/admin/portal-order-documents/:id", async (req, res, next) => {
    try {
        const documentId = toPositiveInt(req.params.id);
        if (!documentId) {
            throw httpError(400, "A valid document id is required.");
        }

        const document = await getPortalOrderDocumentById(documentId);
        if (!document) {
            throw httpError(404, "That shipped document could not be found.");
        }

        res.setHeader("Content-Type", document.file_type || "application/octet-stream");
        res.setHeader("Content-Length", String(document.file_data?.length || document.file_size || 0));
        res.setHeader("Content-Disposition", `inline; filename="${normalizeUploadFileName(document.file_name || "document") || "document"}"`);
        res.send(document.file_data);
    } catch (error) {
        next(error);
    }
});

app.get("/api/portal/order-documents/:id", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        const documentId = toPositiveInt(req.params.id);
        if (!documentId) {
            throw httpError(400, "A valid document id is required.");
        }

        const document = await getPortalOrderDocumentById(documentId);
        if (!document || normalizeText(document.account_name) !== normalizeText(session.access.accountName)) {
            throw httpError(404, "That shipped document could not be found.");
        }

        res.setHeader("Content-Type", document.file_type || "application/octet-stream");
        res.setHeader("Content-Length", String(document.file_data?.length || document.file_size || 0));
        res.setHeader("Content-Disposition", `inline; filename="${normalizeUploadFileName(document.file_name || "document") || "document"}"`);
        res.send(document.file_data);
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.get("/portal", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "portal.html"));
});

app.get("/portal.html", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "portal.html"));
});

app.get("/mobile-pick", async (req, res) => {
    try {
        await requireAppSession(req);
        res.sendFile(path.join(ROOT_DIR, "mobile-pick.html"));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect("/login");
    }
});

app.get("/mobile-pick.html", async (req, res) => {
    try {
        await requireAppSession(req);
        res.sendFile(path.join(ROOT_DIR, "mobile-pick.html"));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect("/login");
    }
});

app.get("/login", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "login.html"));
});

app.get("/login.html", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "login.html"));
});

app.get("/", async (req, res) => {
    try {
        await requireAppSession(req);
        res.sendFile(path.join(ROOT_DIR, "index.html"));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect("/login");
    }
});

app.get("/index.html", async (req, res) => {
    try {
        await requireAppSession(req);
        res.sendFile(path.join(ROOT_DIR, "index.html"));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect("/login");
    }
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

    await pool.query("alter table owner_accounts add column if not exists legal_name text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists account_code text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists contact_name text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists contact_title text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists email text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists phone text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists mobile text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists website text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists billing_email text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists ap_email text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists portal_login_email text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists address1 text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists address2 text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists city text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists state text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists postal_code text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists country text not null default '';");
    await pool.query("alter table owner_accounts add column if not exists is_active boolean not null default true;");

    await pool.query(`
        create table if not exists portal_vendor_access (
            id bigserial primary key,
            account_name text not null unique,
            email text,
            password_hash text not null,
            is_active boolean not null default true,
            last_login_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query("alter table portal_vendor_access drop constraint if exists portal_vendor_access_account_name_key");
    await pool.query("alter table portal_vendor_access add column if not exists email text;");
    await pool.query("update portal_vendor_access set email = lower(email) where email is not null and email <> lower(email)");
    await pool.query("create unique index if not exists idx_portal_vendor_access_email_unique on portal_vendor_access (email) where email is not null and btrim(email) <> ''");

    await pool.query(`
        create table if not exists portal_sessions (
            id bigserial primary key,
            portal_access_id bigint not null references portal_vendor_access(id) on delete cascade,
            token_hash text not null unique,
            expires_at timestamptz not null,
            created_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists app_users (
            id bigserial primary key,
            email text not null unique,
            password_hash text not null,
            full_name text not null default '',
            role text not null default 'super_admin',
            is_active boolean not null default true,
            last_login_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists app_sessions (
            id bigserial primary key,
            app_user_id bigint not null references app_users(id) on delete cascade,
            token_hash text not null unique,
            expires_at timestamptz not null,
            created_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now()
        );
    `);

    await pool.query("update app_users set email = lower(email) where email is not null and email <> lower(email)");
    await ensureDefaultAppAdmin();

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

    await pool.query(`
        create table if not exists billing_fee_catalog (
            code text primary key,
            category text not null,
            name text not null,
            unit_label text not null default '',
            default_rate numeric(12, 4) not null default 0,
            is_active boolean not null default true,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists owner_billing_rates (
            id bigserial primary key,
            account_name text not null,
            fee_code text not null references billing_fee_catalog(code) on delete cascade,
            rate numeric(12, 4) not null default 0,
            is_enabled boolean not null default false,
            unit_label text not null default '',
            note text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (account_name, fee_code)
        );
    `);

    await pool.query(`
        create table if not exists billing_events (
            id bigserial primary key,
            event_key text unique,
            account_name text not null,
            fee_code text not null references billing_fee_catalog(code) on delete restrict,
            fee_category text not null default '',
            fee_name text not null default '',
            unit_label text not null default '',
            quantity numeric(12, 4) not null,
            rate numeric(12, 4) not null,
            amount numeric(12, 4) not null,
            currency_code text not null default 'USD',
            service_date date not null default current_date,
            status text not null default 'OPEN',
            invoice_number text not null default '',
            invoiced_at timestamptz,
            source_type text not null default '',
            source_ref text not null default '',
            reference text not null default '',
            note text not null default '',
            metadata jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint billing_events_status_check check (status in ('OPEN', 'INVOICED', 'VOID'))
        );
    `);

    await pool.query("alter table billing_events add column if not exists event_key text unique");
    await pool.query("alter table billing_events add column if not exists currency_code text not null default 'USD'");
    await pool.query("alter table billing_events add column if not exists invoice_number text not null default ''");
    await pool.query("alter table billing_events add column if not exists invoiced_at timestamptz");
    await pool.query("alter table billing_events add column if not exists source_type text not null default ''");
    await pool.query("alter table billing_events add column if not exists source_ref text not null default ''");
    await pool.query("alter table billing_events add column if not exists reference text not null default ''");
    await pool.query("alter table billing_events add column if not exists note text not null default ''");
    await pool.query("alter table billing_events add column if not exists metadata jsonb not null default '{}'::jsonb");
    await pool.query("alter table billing_events add column if not exists fee_category text not null default ''");
    await pool.query("alter table billing_events add column if not exists fee_name text not null default ''");
    await pool.query("alter table billing_events add column if not exists unit_label text not null default ''");
    await pool.query("alter table billing_events drop constraint if exists billing_events_status_check");
    await pool.query("alter table billing_events add constraint billing_events_status_check check (status in ('OPEN', 'INVOICED', 'VOID'))");
    await pool.query("create index if not exists idx_billing_events_account_date on billing_events (account_name, service_date desc)");
    await pool.query("create index if not exists idx_billing_events_status on billing_events (status, service_date desc)");
    await pool.query("create index if not exists idx_owner_billing_rates_account on owner_billing_rates (account_name)");
    await seedBillingFeeCatalog(pool);

    await pool.query(`
        create table if not exists pallet_records (
            id bigserial primary key,
            pallet_code text not null unique,
            account_name text not null,
            sku text not null,
            upc text not null default '',
            description text not null default '',
            cases_on_pallet integer not null check (cases_on_pallet > 0),
            label_date date not null,
            location text not null default '',
            inventory_tracking_level text not null default 'CASE',
            inventory_quantity integer not null default 0 check (inventory_quantity >= 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists portal_orders (
            id bigserial primary key,
            order_code text,
            account_name text not null,
            portal_access_id bigint references portal_vendor_access(id) on delete set null,
            status text not null default 'DRAFT',
            po_number text not null default '',
            shipping_reference text not null default '',
            contact_name text not null default '',
            contact_phone text not null default '',
            requested_ship_date date,
            order_notes text not null default '',
            ship_to_name text not null default '',
            ship_to_address1 text not null default '',
            ship_to_address2 text not null default '',
            ship_to_city text not null default '',
            ship_to_state text not null default '',
            ship_to_postal_code text not null default '',
            ship_to_country text not null default '',
            ship_to_phone text not null default '',
            confirmed_ship_date date,
            shipped_carrier_name text not null default '',
            shipped_tracking_reference text not null default '',
            shipped_confirmation_note text not null default '',
            released_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint portal_orders_status_check check (status in ('DRAFT', 'RELEASED', 'PICKED', 'STAGED', 'SHIPPED'))
        );
    `);
    await pool.query("alter table portal_orders alter column order_code drop not null");
    await pool.query("alter table portal_orders alter column order_code drop default");
    await pool.query("alter table portal_orders add column if not exists picked_at timestamptz");
    await pool.query("alter table portal_orders add column if not exists staged_at timestamptz");
    await pool.query("alter table portal_orders add column if not exists shipped_at timestamptz");
    await pool.query("alter table portal_orders add column if not exists requested_ship_date date");
    await pool.query("alter table portal_orders add column if not exists order_notes text not null default ''");
    await pool.query("alter table portal_orders add column if not exists confirmed_ship_date date");
    await pool.query("alter table portal_orders add column if not exists shipped_carrier_name text not null default ''");
    await pool.query("alter table portal_orders add column if not exists shipped_tracking_reference text not null default ''");
    await pool.query("alter table portal_orders add column if not exists shipped_confirmation_note text not null default ''");
    await pool.query("alter table portal_orders add column if not exists ship_to_phone text not null default ''");
    await pool.query("alter table portal_orders drop constraint if exists portal_orders_status_check");
    await pool.query("alter table portal_orders add constraint portal_orders_status_check check (status in ('DRAFT', 'RELEASED', 'PICKED', 'STAGED', 'SHIPPED'))");

    await pool.query(`
        create table if not exists portal_inbounds (
            id bigserial primary key,
            inbound_code text,
            account_name text not null,
            portal_access_id bigint references portal_vendor_access(id) on delete set null,
            status text not null default 'SUBMITTED',
            reference_number text not null default '',
            carrier_name text not null default '',
            expected_date date,
            contact_name text not null default '',
            contact_phone text not null default '',
            notes text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint portal_inbounds_status_check check (status in ('SUBMITTED', 'RECEIVED', 'CANCELLED'))
        );
    `);
    await pool.query("alter table portal_inbounds alter column inbound_code drop not null");
    await pool.query("alter table portal_inbounds alter column inbound_code drop default");

    await pool.query(`
        create table if not exists portal_inbound_lines (
            id bigserial primary key,
            inbound_id bigint not null references portal_inbounds(id) on delete cascade,
            line_number integer not null default 1,
            sku text not null,
            expected_quantity integer not null check (expected_quantity > 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);
    await pool.query("update portal_inbounds set inbound_code = null where inbound_code = ''");
    await pool.query("update portal_inbounds set inbound_code = concat('INB-', lpad(id::text, 6, '0')) where inbound_code is null");

    await pool.query(`
        create table if not exists portal_order_lines (
            id bigserial primary key,
            order_id bigint not null references portal_orders(id) on delete cascade,
            line_number integer not null default 1,
            sku text not null,
            requested_quantity integer not null check (requested_quantity > 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);
    await pool.query(`
        create table if not exists portal_order_documents (
            id bigserial primary key,
            order_id bigint not null references portal_orders(id) on delete cascade,
            file_name text not null default '',
            file_type text not null default 'application/octet-stream',
            file_size integer not null default 0 check (file_size >= 0),
            file_data bytea not null,
            uploaded_by text not null default '',
            created_at timestamptz not null default now()
        );
    `);
    await pool.query("update portal_orders set order_code = null where order_code = ''");
    await pool.query("update portal_orders set order_code = concat('ORD-', lpad(id::text, 6, '0')) where order_code is null");
    await pool.query("delete from portal_sessions where expires_at <= now()");

    await pool.query("create unique index if not exists idx_inventory_lines_account_location_sku_unique on inventory_lines (account_name, location, sku);");
    await pool.query("create unique index if not exists idx_item_catalog_account_sku_unique on item_catalog (account_name, sku);");
    await pool.query("create unique index if not exists idx_pallet_records_code_unique on pallet_records (pallet_code);");
    await pool.query("create index if not exists idx_pallet_records_account_name on pallet_records (account_name);");
    await pool.query("create index if not exists idx_pallet_records_location on pallet_records (location);");
    await pool.query("create index if not exists idx_pallet_records_sku on pallet_records (sku);");
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
    await pool.query("create index if not exists idx_portal_vendor_access_account_name on portal_vendor_access (account_name);");
    await pool.query("create index if not exists idx_portal_sessions_access_id on portal_sessions (portal_access_id);");
    await pool.query("create index if not exists idx_portal_sessions_expires_at on portal_sessions (expires_at);");
    await pool.query("create unique index if not exists idx_portal_orders_order_code_unique on portal_orders (order_code);");
    await pool.query("create index if not exists idx_portal_orders_account_name on portal_orders (account_name);");
    await pool.query("create index if not exists idx_portal_orders_status on portal_orders (status);");
    await pool.query("create index if not exists idx_portal_order_lines_order_id on portal_order_lines (order_id);");
    await pool.query("create index if not exists idx_portal_order_documents_order_id on portal_order_documents (order_id);");
    await pool.query("create unique index if not exists idx_portal_inbounds_inbound_code_unique on portal_inbounds (inbound_code);");
    await pool.query("create index if not exists idx_portal_inbounds_account_name on portal_inbounds (account_name);");
    await pool.query("create index if not exists idx_portal_inbounds_status on portal_inbounds (status);");
    await pool.query("create index if not exists idx_portal_inbound_lines_inbound_id on portal_inbound_lines (inbound_id);");
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

    if (!DATABASE_URL) {
        databaseReady = false;
        if (!databaseErrorMessage) {
            databaseErrorMessage = "DATABASE_URL or DATABASE_PRIVATE_URL is required. Add a PostgreSQL database in Railway and expose it to this service.";
        }
        return;
    }

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

async function getServerState(client = pool, { billingEventLimit = 1000 } = {}) {
    const billingEventsQuery = Number.isFinite(billingEventLimit) && billingEventLimit > 0
        ? client.query("select * from billing_events order by service_date desc, id desc limit $1", [billingEventLimit])
        : client.query("select * from billing_events order by service_date desc, id desc");

    const [inventoryResult, activityResult, locationResult, ownerResult, itemResult, palletResult, billingFeeResult, ownerRateResult, billingEventResult, metaResult] = await Promise.all([
        client.query("select * from inventory_lines order by account_name asc, location asc, sku asc"),
        client.query("select * from activity_log order by created_at desc limit $1", [80]),
        client.query("select * from bin_locations order by code asc"),
        client.query("select * from owner_accounts order by name asc"),
        client.query("select * from item_catalog order by account_name asc, sku asc"),
        client.query("select * from pallet_records order by updated_at desc, pallet_code asc"),
        client.query("select * from billing_fee_catalog order by category asc, name asc"),
        client.query("select * from owner_billing_rates order by account_name asc, fee_code asc"),
        billingEventsQuery,
        client.query(`
            select nullif(
                greatest(
                    coalesce((select max(updated_at) from inventory_lines), to_timestamp(0)),
                    coalesce((select max(created_at) from activity_log), to_timestamp(0)),
                    coalesce((select max(updated_at) from bin_locations), to_timestamp(0)),
                    coalesce((select max(updated_at) from owner_accounts), to_timestamp(0)),
                    coalesce((select max(updated_at) from item_catalog), to_timestamp(0)),
                    coalesce((select max(updated_at) from pallet_records), to_timestamp(0)),
                    coalesce((select max(updated_at) from billing_fee_catalog), to_timestamp(0)),
                    coalesce((select max(updated_at) from owner_billing_rates), to_timestamp(0)),
                    coalesce((select max(updated_at) from billing_events), to_timestamp(0))
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
        pallets: palletResult.rows.map(mapPalletRecordRow),
        activity: activityResult.rows.map(mapActivityRow),
        masters: {
            locations: locationResult.rows.map(mapLocationMasterRow),
            ownerRecords: ownerResult.rows.map(mapOwnerMasterRow),
            items: itemResult.rows.map(mapItemMasterRow),
            owners
        },
        billing: {
            feeCatalog: billingFeeResult.rows.map(mapBillingFeeRow),
            ownerRates: ownerRateResult.rows.map(mapOwnerBillingRateRow),
            events: billingEventResult.rows.map(mapBillingEventRow)
        },
        meta: {
            version: 7,
            lastChangedAt: metaResult.rows[0].last_changed_at ? new Date(metaResult.rows[0].last_changed_at).toISOString() : null,
            serverSyncedAt: new Date().toISOString()
        }
    };
}

function normalizeBillingMonth(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/^\d{4}-\d{2}$/.test(text)) return text;
    const normalizedDate = normalizeDateInput(text);
    return normalizedDate ? normalizedDate.slice(0, 7) : "";
}

function roundBillingNumber(value, digits = 4) {
    const factor = 10 ** digits;
    const numeric = Number.parseFloat(String(value));
    if (!Number.isFinite(numeric)) return 0;
    return Math.round(numeric * factor) / factor;
}

function formatMoney(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(roundBillingNumber(value, 2));
}

function formatBillingQuantity(value) {
    const numeric = roundBillingNumber(value);
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, "");
}

function sanitizeBillingFeeInput(item) {
    const code = normalizeText(item?.code);
    if (!code) return null;
    return {
        code,
        category: normalizeFreeText(item?.category || "General"),
        name: normalizeFreeText(item?.name || code.replace(/_/g, " ")),
        unitLabel: normalizeFreeText(item?.unitLabel || item?.unit_label || ""),
        defaultRate: roundBillingNumber(item?.defaultRate ?? item?.default_rate ?? 0),
        isActive: item?.isActive !== false,
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function sanitizeOwnerBillingRateInput(item, fallbackAccountName = "") {
    const accountName = normalizeText(item?.accountName || item?.owner || item?.vendor || item?.customer || fallbackAccountName);
    const feeCode = normalizeText(item?.feeCode || item?.code);
    if (!accountName || !feeCode) return null;
    return {
        accountName,
        feeCode,
        rate: roundBillingNumber(item?.rate ?? 0),
        isEnabled: item?.isEnabled === true || item?.enabled === true,
        unitLabel: normalizeFreeText(item?.unitLabel || item?.unit_label || ""),
        note: normalizeFreeText(item?.note || ""),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function sanitizeBillingEventInput(item) {
    const accountName = normalizeText(item?.accountName || item?.owner || item?.vendor || item?.customer);
    const feeCode = normalizeText(item?.feeCode || item?.code);
    if (!accountName || !feeCode) return null;

    const metadata = item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata : {};
    const serviceDate = normalizeDateInput(item?.serviceDate || item?.date) || new Date().toISOString().slice(0, 10);
    const status = normalizeText(item?.status || "OPEN");

    return {
        id: item?.id == null ? null : Number.parseInt(String(item.id), 10),
        eventKey: typeof item?.eventKey === "string" && item.eventKey.trim() ? item.eventKey.trim() : null,
        accountName,
        feeCode,
        feeCategory: normalizeFreeText(item?.feeCategory || item?.category || ""),
        feeName: normalizeFreeText(item?.feeName || item?.name || ""),
        unitLabel: normalizeFreeText(item?.unitLabel || item?.unit_label || ""),
        quantity: roundBillingNumber(item?.quantity ?? 0),
        rate: roundBillingNumber(item?.rate ?? 0),
        amount: roundBillingNumber(item?.amount ?? 0),
        currencyCode: normalizeText(item?.currencyCode || item?.currency_code || "USD"),
        serviceDate,
        status: ["OPEN", "INVOICED", "VOID"].includes(status) ? status : "OPEN",
        invoiceNumber: normalizeFreeText(item?.invoiceNumber || item?.invoice_number || ""),
        invoicedAt: typeof item?.invoicedAt === "string" ? item.invoicedAt : (typeof item?.invoiced_at === "string" ? item.invoiced_at : null),
        sourceType: normalizeText(item?.sourceType || item?.source_type || ""),
        sourceRef: normalizeFreeText(item?.sourceRef || item?.source_ref || ""),
        reference: normalizeFreeText(item?.reference || ""),
        note: normalizeFreeText(item?.note || ""),
        metadata,
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function sanitizeManualBillingEventInput(item) {
    const accountName = normalizeText(item?.accountName || item?.owner || item?.vendor || item?.customer);
    const feeCode = normalizeText(item?.feeCode || item?.code);
    const quantity = roundBillingNumber(item?.quantity ?? 0);
    if (!accountName || !feeCode || quantity <= 0) return null;
    return {
        accountName,
        feeCode,
        quantity,
        rate: item?.rate == null || item?.rate === "" ? null : roundBillingNumber(item.rate),
        serviceDate: normalizeDateInput(item?.serviceDate || item?.date) || new Date().toISOString().slice(0, 10),
        reference: normalizeFreeText(item?.reference || ""),
        note: normalizeFreeText(item?.note || ""),
        description: normalizeFreeText(item?.description || ""),
        eventKey: typeof item?.eventKey === "string" ? item.eventKey.trim() : ""
    };
}

async function seedBillingFeeCatalog(client = pool) {
    for (const seed of BILLING_FEE_SEED) {
        await client.query(
            `
                insert into billing_fee_catalog (code, category, name, unit_label, default_rate, is_active)
                values ($1, $2, $3, $4, $5, true)
                on conflict (code)
                do update set
                    category = excluded.category,
                    name = excluded.name,
                    unit_label = excluded.unit_label,
                    default_rate = excluded.default_rate,
                    updated_at = now()
            `,
            [seed.code, seed.category, seed.name, seed.unitLabel, seed.defaultRate]
        );
    }
}

async function getOwnerBillingRates(client = pool, accountName = "") {
    const normalizedAccount = normalizeText(accountName);
    const result = normalizedAccount
        ? await client.query("select * from owner_billing_rates where account_name = $1 order by fee_code asc", [normalizedAccount])
        : await client.query("select * from owner_billing_rates order by account_name asc, fee_code asc");
    return result.rows.map(mapOwnerBillingRateRow);
}

async function saveOwnerBillingRates(client, accountName, inputRates) {
    const normalizedAccount = normalizeText(accountName);
    if (!normalizedAccount) return [];

    const uniqueRates = new Map();
    for (const rawRate of Array.isArray(inputRates) ? inputRates : []) {
        const rate = sanitizeOwnerBillingRateInput(rawRate, normalizedAccount);
        if (!rate) continue;
        uniqueRates.set(rate.feeCode, rate);
    }

    await client.query("delete from owner_billing_rates where account_name = $1", [normalizedAccount]);
    for (const rate of uniqueRates.values()) {
        await client.query(
            `
                insert into owner_billing_rates (account_name, fee_code, rate, is_enabled, unit_label, note)
                values ($1, $2, $3, $4, $5, $6)
            `,
            [normalizedAccount, rate.feeCode, rate.rate, rate.isEnabled === true, rate.unitLabel, rate.note]
        );
    }

    return getOwnerBillingRates(client, normalizedAccount);
}

async function getResolvedBillingFee(client, accountName, feeCode) {
    const normalizedAccount = normalizeText(accountName);
    const normalizedFeeCode = normalizeText(feeCode);
    const result = await client.query(
        `
            select
                c.*,
                r.rate as owner_rate,
                r.is_enabled as owner_enabled,
                r.unit_label as owner_unit_label,
                r.note as owner_note
            from billing_fee_catalog c
            left join owner_billing_rates r
              on r.fee_code = c.code
             and r.account_name = $1
            where c.code = $2
            limit 1
        `,
        [normalizedAccount, normalizedFeeCode]
    );

    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
        code: row.code,
        category: row.category,
        name: row.name,
        unitLabel: row.unit_label || "",
        defaultRate: roundBillingNumber(row.default_rate),
        isActive: row.is_active !== false,
        rate: row.owner_rate == null ? roundBillingNumber(row.default_rate) : roundBillingNumber(row.owner_rate),
        isEnabled: row.owner_enabled === true,
        note: row.owner_note || "",
        effectiveUnitLabel: row.owner_unit_label || row.unit_label || ""
    };
}

async function createBillingEventForFee(client, accountName, feeCode, quantity, options = {}) {
    const normalizedAccount = normalizeText(accountName);
    const numericQuantity = roundBillingNumber(quantity);
    if (!normalizedAccount || numericQuantity <= 0) return null;

    const fee = await getResolvedBillingFee(client, normalizedAccount, feeCode);
    if (!fee || fee.isActive === false || fee.isEnabled !== true) {
        return null;
    }

    const rate = options.rateOverride == null ? fee.rate : roundBillingNumber(options.rateOverride);
    const serviceDate = normalizeDateInput(options.serviceDate) || new Date().toISOString().slice(0, 10);
    const eventKey = typeof options.eventKey === "string" && options.eventKey.trim() ? options.eventKey.trim() : null;
    const amount = roundBillingNumber(numericQuantity * rate);
    const sourceType = normalizeText(options.sourceType || "");
    const sourceRef = normalizeFreeText(options.sourceRef || "");
    const reference = normalizeFreeText(options.reference || "");
    const note = normalizeFreeText(options.note || "");
    const metadata = options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata) ? options.metadata : {};

    const params = [
        eventKey,
        normalizedAccount,
        fee.code,
        fee.category,
        options.description ? normalizeFreeText(options.description) : fee.name,
        normalizeFreeText(fee.effectiveUnitLabel || fee.unitLabel),
        numericQuantity,
        rate,
        amount,
        normalizeText(options.currencyCode || "USD") || "USD",
        serviceDate,
        sourceType,
        sourceRef,
        reference,
        note,
        JSON.stringify(metadata)
    ];

    if (eventKey) {
        const upsertResult = await client.query(
            `
                insert into billing_events (
                    event_key, account_name, fee_code, fee_category, fee_name, unit_label,
                    quantity, rate, amount, currency_code, service_date,
                    source_type, source_ref, reference, note, metadata
                )
                values (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11,
                    $12, $13, $14, $15, $16::jsonb
                )
                on conflict (event_key)
                do update set
                    quantity = excluded.quantity,
                    rate = excluded.rate,
                    amount = excluded.amount,
                    service_date = excluded.service_date,
                    fee_category = excluded.fee_category,
                    fee_name = excluded.fee_name,
                    unit_label = excluded.unit_label,
                    source_type = excluded.source_type,
                    source_ref = excluded.source_ref,
                    reference = excluded.reference,
                    note = excluded.note,
                    metadata = excluded.metadata,
                    updated_at = now()
                where billing_events.status = 'OPEN'
                returning *
            `,
            params
        );

        if (upsertResult.rowCount > 0) {
            return mapBillingEventRow(upsertResult.rows[0]);
        }

        const existing = await client.query("select * from billing_events where event_key = $1 limit 1", [eventKey]);
        return existing.rowCount === 1 ? mapBillingEventRow(existing.rows[0]) : null;
    }

    const insertResult = await client.query(
        `
            insert into billing_events (
                event_key, account_name, fee_code, fee_category, fee_name, unit_label,
                quantity, rate, amount, currency_code, service_date,
                source_type, source_ref, reference, note, metadata
            )
            values (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13, $14, $15, $16::jsonb
            )
            returning *
        `,
        params
    );
    return mapBillingEventRow(insertResult.rows[0]);
}

function addBillingRollup(grouped, accountName, feeCode, quantity) {
    const normalizedAccount = normalizeText(accountName);
    const numericQuantity = roundBillingNumber(quantity);
    if (!normalizedAccount || !feeCode || numericQuantity <= 0) return;
    const key = `${normalizedAccount}::${feeCode}`;
    const current = grouped.get(key) || { accountName: normalizedAccount, feeCode, quantity: 0 };
    current.quantity = roundBillingNumber(current.quantity + numericQuantity);
    grouped.set(key, current);
}

async function createBatchBillingEvents(client, items, batchRef) {
    const grouped = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const trackingLevel = normalizeTrackingLevel(item?.trackingLevel);
        const quantity = Number(item?.quantity) || 0;
        if (!item?.accountName || quantity <= 0) continue;

        if (trackingLevel === "PALLET") {
            addBillingRollup(grouped, item.accountName, "PALLET_RECEIVING_FEE", quantity);
            addBillingRollup(grouped, item.accountName, "PUT_AWAY_PALLET", quantity);
            continue;
        }

        if (trackingLevel === "CASE") {
            addBillingRollup(grouped, item.accountName, "CARTON_RECEIVING_FEE", quantity);
            addBillingRollup(grouped, item.accountName, "PUT_AWAY_CARTON", quantity);
            continue;
        }

        const unitsPerCase = Number(item?.unitsPerCase) || 0;
        if (trackingLevel === "UNIT" && unitsPerCase > 0 && quantity % unitsPerCase === 0) {
            const cartonCount = quantity / unitsPerCase;
            addBillingRollup(grouped, item.accountName, "CARTON_RECEIVING_FEE", cartonCount);
            addBillingRollup(grouped, item.accountName, "PUT_AWAY_CARTON", cartonCount);
        }
    }

    const created = [];
    for (const entry of grouped.values()) {
        const billLine = await createBillingEventForFee(client, entry.accountName, entry.feeCode, entry.quantity, {
            sourceType: "RECEIVING",
            sourceRef: batchRef,
            reference: batchRef,
            note: "Auto-created from saved receiving batch.",
            eventKey: `${batchRef}:${entry.accountName}:${entry.feeCode}`
        });
        if (billLine) created.push(billLine);
    }
    return created;
}

async function createPortalOrderBillingEvents(client, order) {
    if (!order?.id || !order?.accountName) return [];

    let unitQuantity = 0;
    let caseQuantity = 0;
    let palletQuantity = 0;

    for (const line of Array.isArray(order.lines) ? order.lines : []) {
        const quantity = Number(line?.quantity) || 0;
        const trackingLevel = normalizeTrackingLevel(line?.trackingLevel);
        if (quantity <= 0) continue;
        if (trackingLevel === "PALLET") palletQuantity += quantity;
        else if (trackingLevel === "CASE") caseQuantity += quantity;
        else unitQuantity += quantity;
    }

    const created = [];
    const sourceType = "OUTBOUND_ORDER";
    const sourceRef = order.orderCode || `ORDER-${order.id}`;
    const reference = order.poNumber || order.shippingReference || sourceRef;

    const pushCreated = async (feeCode, quantity, suffix) => {
        const line = await createBillingEventForFee(client, order.accountName, feeCode, quantity, {
            sourceType,
            sourceRef,
            reference,
            note: `Auto-created when portal order ${sourceRef} was shipped.`,
            eventKey: `ORDER:${order.id}:${suffix || feeCode}`
        });
        if (line) created.push(line);
    };

    await pushCreated("SHIPPING_ADMINISTRATION_FEE", 1, "SHIP_ADMIN");

    if (unitQuantity > 0) {
        await pushCreated("ORDER_PROCESSING_FIRST_ITEM", 1, "B2C_FIRST");
        if (unitQuantity > 1) {
            await pushCreated("ADDITIONAL_ITEM_PICK", unitQuantity - 1, "B2C_ADDITIONAL");
        }
    }

    if (caseQuantity > 0) {
        await pushCreated("CARTON_PICK_FEE", 1, "B2B_CASE_FIRST");
        if (caseQuantity > 1) {
            await pushCreated("ADDITIONAL_CARTON_PICK_FEE", caseQuantity - 1, "B2B_CASE_ADDITIONAL");
        }
    }

    if (palletQuantity > 0) {
        await pushCreated("PALLET_PICK_FEE", palletQuantity, "B2B_PALLET");
    }

    return created;
}

async function createMonthlyStorageBillingEvents(client, accountName, month) {
    const normalizedAccount = normalizeText(accountName);
    const normalizedMonth = normalizeBillingMonth(month);
    if (!normalizedAccount || !normalizedMonth) return [];

    const snapshot = await client.query(
        `
            select
                coalesce(sum(case when tracking_level = 'PALLET' then quantity else 0 end), 0)::integer as pallet_count,
                count(distinct case when tracking_level <> 'PALLET' then location else null end)::integer as floor_positions
            from inventory_lines
            where account_name = $1
        `,
        [normalizedAccount]
    );

    const palletCount = Number(snapshot.rows[0]?.pallet_count) || 0;
    const floorPositions = Number(snapshot.rows[0]?.floor_positions) || 0;
    const serviceDate = `${normalizedMonth}-01`;
    const created = [];

    if (palletCount > 0) {
        const palletLine = await createBillingEventForFee(client, normalizedAccount, "STANDARD_PALLET_STORAGE", palletCount, {
            sourceType: "STORAGE_MONTHLY",
            sourceRef: normalizedMonth,
            reference: normalizedMonth,
            serviceDate,
            note: `Auto-generated from live pallet-tracked inventory for ${normalizedMonth}.`,
            eventKey: `STORAGE:${normalizedAccount}:${normalizedMonth}:STANDARD_PALLET_STORAGE`
        });
        if (palletLine) created.push(palletLine);
    }

    if (floorPositions > 0) {
        const floorLine = await createBillingEventForFee(client, normalizedAccount, "FLOOR_STORAGE", floorPositions, {
            sourceType: "STORAGE_MONTHLY",
            sourceRef: normalizedMonth,
            reference: normalizedMonth,
            serviceDate,
            note: `Auto-generated from live floor-position inventory for ${normalizedMonth}.`,
            eventKey: `STORAGE:${normalizedAccount}:${normalizedMonth}:FLOOR_STORAGE`
        });
        if (floorLine) created.push(floorLine);
    }

    return created;
}

async function ensureDefaultAppAdmin() {
    const email = normalizeEmail(DEFAULT_ADMIN_EMAIL);
    if (!email) return;
    const existing = await pool.query("select id from app_users where email = $1 limit 1", [email]);
    if (existing.rowCount > 0) return;
    await pool.query(
        `
            insert into app_users (email, password_hash, full_name, role, is_active)
            values ($1, $2, $3, 'super_admin', true)
        `,
        [email, hashPortalPassword(DEFAULT_ADMIN_PASSWORD), DEFAULT_ADMIN_NAME || 'Platform Owner']
    );
    console.log(`Created default warehouse admin login for ${email}`);
}

async function getAppUserByEmail(client, email) {
    const normalizedEmail = normalizeEmail(email);
    const result = await client.query("select * from app_users where email = $1 limit 1", [normalizedEmail]);
    return result.rows[0] || null;
}

async function getAppUserById(client, userId) {
    const result = await client.query("select * from app_users where id = $1 limit 1", [userId]);
    return result.rows[0] || null;
}

async function createAppSession(client, userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashPortalSessionToken(token);
    const expiresAt = new Date(Date.now() + (APP_SESSION_MAX_AGE * 1000)).toISOString();
    await client.query("delete from app_sessions where app_user_id = $1 or expires_at <= now()", [userId]);
    await client.query(
        `
            insert into app_sessions (app_user_id, token_hash, expires_at)
            values ($1, $2, $3)
        `,
        [userId, tokenHash, expiresAt]
    );
    return token;
}

async function deleteAppSessionByToken(token, client = pool) {
    const normalizedToken = String(token || "").trim();
    if (!normalizedToken) return;
    await client.query("delete from app_sessions where token_hash = $1", [hashPortalSessionToken(normalizedToken)]);
}

function getAppSessionToken(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return cookies[APP_SESSION_COOKIE] || "";
}

async function requireAppSession(req, client = pool) {
    const token = getAppSessionToken(req);
    if (!token) {
        throw httpError(401, "Warehouse login required.");
    }

    const result = await client.query(
        `
            select
                s.id as session_id,
                s.app_user_id,
                s.expires_at,
                u.*
            from app_sessions s
            join app_users u on u.id = s.app_user_id
            where s.token_hash = $1
              and s.expires_at > now()
            limit 1
        `,
        [hashPortalSessionToken(token)]
    );

    if (result.rowCount !== 1) {
        throw httpError(401, "Warehouse session expired. Please log in again.");
    }

    const row = result.rows[0];
    if (!row.is_active) {
        throw httpError(401, "That warehouse login is no longer active.");
    }

    await client.query("update app_sessions set last_seen_at = now() where id = $1", [row.session_id]);
    return { sessionId: String(row.session_id), user: row };
}

function requiresAppAuth(req) {
    const pathName = req.path || req.url || "";
    if (pathName === "/api/health" || pathName === "/api/app/login" || pathName === "/api/app/logout" || pathName === "/api/app/me") return false;
    if (pathName.startsWith("/api/portal/")) return false;
    return pathName.startsWith("/api/");
}

function mapAppUserRow(row) {
    return {
        id: String(row.id),
        email: row.email,
        fullName: row.full_name || "",
        role: row.role || "",
        isActive: row.is_active !== false,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

async function getPortalAccessList(client = pool) {
    const result = await client.query("select * from portal_vendor_access order by account_name asc, email asc, id asc");
    return result.rows.map(mapPortalAccessRow);
}

async function getPortalAccessByAccountName(client, accountName) {
    const normalizedAccount = normalizeText(accountName);
    if (!normalizedAccount) return null;
    const result = await client.query("select * from portal_vendor_access where account_name = $1 limit 1", [normalizedAccount]);
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function getPortalAccessById(client, accessId) {
    const result = await client.query("select * from portal_vendor_access where id = $1 limit 1", [accessId]);
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function getPortalAccessByEmail(client, email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    const result = await client.query("select * from portal_vendor_access where email = $1 limit 1", [normalizedEmail]);
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function savePortalAccess(client, { accessId, accountName, email, password, isActive }) {
    const normalizedAccount = normalizeText(accountName);
    const normalizedEmail = normalizeEmail(email);
    const passwordText = typeof password === "string" ? password : "";
    const existingById = accessId ? await getPortalAccessById(client, accessId) : null;
    const existingByEmail = await getPortalAccessByEmail(client, normalizedEmail);
    const existing = existingById || existingByEmail;

    if (!normalizedEmail) {
        throw httpError(400, "A valid user email address is required.");
    }
    if (!existing && !passwordText.trim()) {
        throw httpError(400, "Set a password the first time you enable company portal access.");
    }
    if (passwordText && passwordText.length < 8) {
        throw httpError(400, "Portal passwords must be at least 8 characters.");
    }

    if (existingByEmail && (!existing || String(existingByEmail.id) !== String(existing.id))) {
        throw httpError(400, "That email address is already linked to another portal account.");
    }

    if (existing) {
        const passwordHash = passwordText ? hashPortalPassword(passwordText) : existing.password_hash;
        const result = await client.query(
            `
                update portal_vendor_access
                set
                    account_name = $2,
                    email = $3,
                    password_hash = $4,
                    is_active = $5,
                    updated_at = now()
                where id = $1
                returning *
            `,
            [existing.id, normalizedAccount, normalizedEmail, passwordHash, isActive !== false]
        );
        const row = result.rows[0];
        row.wasCreated = false;
        return row;
    }

    const result = await client.query(
        `
            insert into portal_vendor_access (account_name, email, password_hash, is_active)
            values ($1, $2, $3, $4)
            returning *
        `,
        [normalizedAccount, normalizedEmail, hashPortalPassword(passwordText), isActive !== false]
    );
    const row = result.rows[0];
    row.wasCreated = true;
    return row;
}

function getPortalSessionToken(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return cookies[PORTAL_SESSION_COOKIE] || "";
}

async function createPortalSession(client, accessId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashPortalSessionToken(token);
    const expiresAt = new Date(Date.now() + (PORTAL_SESSION_MAX_AGE * 1000)).toISOString();
    await client.query("delete from portal_sessions where portal_access_id = $1 or expires_at <= now()", [accessId]);
    await client.query(
        `
            insert into portal_sessions (portal_access_id, token_hash, expires_at)
            values ($1, $2, $3)
        `,
        [accessId, tokenHash, expiresAt]
    );
    return token;
}

async function deletePortalSessionByToken(token, client = pool) {
    const normalizedToken = String(token || "").trim();
    if (!normalizedToken) return;
    await client.query("delete from portal_sessions where token_hash = $1", [hashPortalSessionToken(normalizedToken)]);
}

async function requirePortalSession(req, client = pool) {
    const token = getPortalSessionToken(req);
    if (!token) {
        throw httpError(401, "Portal login required.");
    }

    const result = await client.query(
        `
            select
                s.id as session_id,
                s.portal_access_id,
                s.expires_at,
                a.*
            from portal_sessions s
            join portal_vendor_access a on a.id = s.portal_access_id
            where s.token_hash = $1
              and s.expires_at > now()
            limit 1
        `,
        [hashPortalSessionToken(token)]
    );

    if (result.rowCount !== 1) {
        throw httpError(401, "Portal session expired. Please log in again.");
    }

    const row = result.rows[0];
    if (!row.is_active) {
        throw httpError(401, "That company portal login is no longer active.");
    }

    await client.query("update portal_sessions set last_seen_at = now() where id = $1", [row.session_id]);
    return {
        sessionId: String(row.session_id),
        access: mapPortalAccessRow(row),
        accessRow: row
    };
}

async function getPortalInventorySummary(accountName, client = pool) {
    const normalizedAccount = normalizeText(accountName);
    const result = await client.query(
        `
            with on_hand as (
                select
                    i.account_name,
                    i.sku,
                    coalesce(max(nullif(i.upc, '')), max(nullif(c.upc, '')), '') as upc,
                    coalesce(max(nullif(c.description, '')), '') as description,
                    coalesce(max(nullif(c.image_url, '')), '') as image_url,
                    coalesce(max(nullif(c.tracking_level, '')), max(nullif(i.tracking_level, '')), 'UNIT') as tracking_level,
                    sum(i.quantity)::integer as on_hand_quantity,
                    count(distinct i.location)::integer as location_count,
                    array_remove(array_agg(distinct i.location order by i.location), null) as locations
                from inventory_lines i
                left join item_catalog c
                  on c.account_name = i.account_name
                 and c.sku = i.sku
                where i.account_name = $1
                group by i.account_name, i.sku
            ),
            reserved as (
                select
                    o.account_name,
                    l.sku,
                    coalesce(sum(l.requested_quantity), 0)::integer as reserved_quantity
                from portal_orders o
                join portal_order_lines l on l.order_id = o.id
                where o.account_name = $1
                  and o.status = any($2::text[])
                group by o.account_name, l.sku
            )
            select
                h.account_name,
                h.sku,
                h.upc,
                h.description,
                h.image_url,
                h.tracking_level,
                h.on_hand_quantity as total_quantity,
                h.on_hand_quantity,
                coalesce(r.reserved_quantity, 0)::integer as reserved_quantity,
                greatest(h.on_hand_quantity - coalesce(r.reserved_quantity, 0), 0)::integer as available_quantity,
                h.location_count,
                h.locations
            from on_hand h
            left join reserved r
              on r.account_name = h.account_name
             and r.sku = h.sku
            order by h.sku asc
        `,
        [normalizedAccount, ACTIVE_PORTAL_ORDER_STATUSES]
    );
    return result.rows.map(mapPortalInventoryRow);
}

async function getPortalItemsForAccount(accountName, client = pool) {
    const normalizedAccount = normalizeText(accountName);
    const result = await client.query(
        `
            select *
            from item_catalog
            where account_name = $1
            order by sku asc
        `,
        [normalizedAccount]
    );
    return result.rows.map(mapPortalItemRow);
}


async function buildPortalOrderLocationSummaries(client, lineRows = []) {
    const skuPairs = [];
    const seen = new Set();
    for (const row of lineRows) {
        const accountName = normalizeText(row.account_name);
        const sku = normalizeText(row.sku);
        if (!accountName || !sku) continue;
        const key = `${accountName}::${sku}`;
        if (seen.has(key)) continue;
        seen.add(key);
        skuPairs.push({ accountName, sku });
    }

    const summaries = new Map();
    if (!skuPairs.length) return summaries;

    const accounts = skuPairs.map((pair) => pair.accountName);
    const skus = skuPairs.map((pair) => pair.sku);
    const result = await client.query(
        `
            select
                account_name,
                sku,
                location,
                coalesce(max(nullif(tracking_level, '')), 'UNIT') as tracking_level,
                sum(quantity)::integer as quantity
            from inventory_lines
            where (account_name, sku) in (
                select *
                from unnest($1::text[], $2::text[])
            )
            group by account_name, sku, location
            order by account_name asc, sku asc, location asc
        `,
        [accounts, skus]
    );

    const byKey = new Map();
    result.rows.forEach((row) => {
        const key = `${normalizeText(row.account_name)}::${normalizeText(row.sku)}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                trackingLevel: normalizeTrackingLevel(row.tracking_level || 'UNIT'),
                onHandQuantity: 0,
                availableQuantity: 0,
                locations: []
            });
        }
        const summary = byKey.get(key);
        const quantity = Number(row.quantity) || 0;
        summary.onHandQuantity += quantity;
        summary.availableQuantity += quantity;
        summary.locations.push({
            location: row.location || '',
            quantity,
            trackingLevel: normalizeTrackingLevel(row.tracking_level || summary.trackingLevel || 'UNIT')
        });
    });

    byKey.forEach((value, key) => summaries.set(key, value));
    return summaries;
}

async function getPortalOrdersForAccount(accountName, client = pool) {
    const normalizedAccount = normalizeText(accountName);
    const ordersResult = await client.query(
        `
            select *
            from portal_orders
            where account_name = $1
            order by created_at desc, id desc
            limit 100
        `,
        [normalizedAccount]
    );

    const orderIds = ordersResult.rows.map((row) => row.id);
    const linesResult = orderIds.length
        ? await client.query(
            `
                select
                    l.*,
                    o.account_name,
                    c.description as item_description,
                    c.upc as item_upc,
                    c.tracking_level as item_tracking_level
                from portal_order_lines l
                join portal_orders o on o.id = l.order_id
                left join item_catalog c
                  on c.account_name = o.account_name
                 and c.sku = l.sku
                where l.order_id = any($1::bigint[])
                order by l.order_id desc, l.line_number asc, l.id asc
            `,
            [orderIds]
        )
        : { rows: [] };
    const documentsResult = orderIds.length
        ? await client.query(
            `
                select *
                from portal_order_documents
                where order_id = any($1::bigint[])
                order by created_at asc, id asc
            `,
            [orderIds]
        )
        : { rows: [] };
    const locationSummaries = await buildPortalOrderLocationSummaries(client, linesResult.rows);

    return mapPortalOrders(ordersResult.rows, linesResult.rows, documentsResult.rows, "/api/portal/order-documents", locationSummaries);
}

async function getAdminPortalOrders(client = pool) {
    const ordersResult = await client.query(
        `
            select *
            from portal_orders
            order by created_at desc, id desc
            limit 150
        `
    );
    const orderIds = ordersResult.rows.map((row) => row.id);
    const linesResult = orderIds.length
        ? await client.query(
            `
                select
                    l.*,
                    o.account_name,
                    c.description as item_description,
                    c.upc as item_upc,
                    c.tracking_level as item_tracking_level
                from portal_order_lines l
                join portal_orders o on o.id = l.order_id
                left join item_catalog c
                  on c.account_name = o.account_name
                 and c.sku = l.sku
                where l.order_id = any($1::bigint[])
                order by l.order_id desc, l.line_number asc, l.id asc
            `,
            [orderIds]
        )
        : { rows: [] };
    const documentsResult = orderIds.length
        ? await client.query(
            `
                select *
                from portal_order_documents
                where order_id = any($1::bigint[])
                order by created_at asc, id asc
            `,
            [orderIds]
        )
        : { rows: [] };
    const locationSummaries = await buildPortalOrderLocationSummaries(client, linesResult.rows);

    return mapPortalOrders(ordersResult.rows, linesResult.rows, documentsResult.rows, "/api/admin/portal-order-documents", locationSummaries);
}

async function getPortalOrderById(client, orderId, accountName, downloadPathPrefix = "/api/admin/portal-order-documents") {
    const normalizedAccount = normalizeText(accountName);
    const orderResult = await client.query(
        "select * from portal_orders where id = $1 and account_name = $2 limit 1",
        [orderId, normalizedAccount]
    );
    if (orderResult.rowCount !== 1) {
        return null;
    }

    const linesResult = await client.query(
        `
            select
                l.*,
                o.account_name,
                c.description as item_description,
                c.upc as item_upc,
                c.tracking_level as item_tracking_level
            from portal_order_lines l
            join portal_orders o on o.id = l.order_id
            left join item_catalog c
              on c.account_name = o.account_name
             and c.sku = l.sku
            where l.order_id = $1
            order by l.line_number asc, l.id asc
        `,
        [orderId]
    );
    const documentsResult = await client.query(
        `
            select *
            from portal_order_documents
            where order_id = $1
            order by created_at asc, id asc
        `,
        [orderId]
    );
    const locationSummaries = await buildPortalOrderLocationSummaries(client, linesResult.rows);

    return mapPortalOrders(orderResult.rows, linesResult.rows, documentsResult.rows, downloadPathPrefix, locationSummaries)[0] || null;
}

async function savePortalOrderDraft(client, accessRow, rawOrder, orderId = null) {
    const access = mapPortalAccessRow(accessRow);
    const order = sanitizePortalOrderInput(rawOrder, access.accountName);

    if (!order.poNumber || !order.shippingReference || !order.contactName || !order.contactPhone) {
        throw httpError(400, "PO number, shipping reference, contact name, and contact phone are required.");
    }
    if (!order.requestedShipDate) {
        throw httpError(400, "Requested ship date is required.");
    }
    if (!order.shipToAddress1 || !order.shipToCity || !order.shipToState || !order.shipToPostalCode || !order.shipToCountry) {
        throw httpError(400, "A full ship-to address is required.");
    }
    if (!order.lines.length) {
        throw httpError(400, "Add at least one order line before saving.");
    }

    for (const line of order.lines) {
        await assertPortalOrderSkuAllowed(client, access.accountName, line.sku, line.quantity);
    }

    let savedOrderId = orderId;
    if (savedOrderId) {
        const existing = await getPortalOrderById(client, savedOrderId, access.accountName, "/api/portal/order-documents");
        if (!existing) {
            throw httpError(404, "That draft order could not be found.");
        }
        if (existing.status !== "DRAFT") {
            throw httpError(400, "Released orders can no longer be edited from the company portal.");
        }

        await client.query(
            `
                update portal_orders
                set
                    po_number = $2,
                    shipping_reference = $3,
                    contact_name = $4,
                    contact_phone = $5,
                    requested_ship_date = $6,
                    order_notes = $7,
                    ship_to_name = $8,
                    ship_to_address1 = $9,
                    ship_to_address2 = $10,
                    ship_to_city = $11,
                    ship_to_state = $12,
                    ship_to_postal_code = $13,
                    ship_to_country = $14,
                    ship_to_phone = $15,
                    updated_at = now()
                where id = $1
            `,
            [
                savedOrderId,
                order.poNumber,
                order.shippingReference,
                order.contactName,
                order.contactPhone,
                order.requestedShipDate,
                order.orderNotes,
                order.shipToName,
                order.shipToAddress1,
                order.shipToAddress2,
                order.shipToCity,
                order.shipToState,
                order.shipToPostalCode,
                order.shipToCountry,
                order.shipToPhone
            ]
        );
        await client.query("delete from portal_order_lines where order_id = $1", [savedOrderId]);
    } else {
        const insertResult = await client.query(
            `
                insert into portal_orders (
                    account_name, portal_access_id, po_number, shipping_reference,
                    contact_name, contact_phone, requested_ship_date, order_notes,
                    ship_to_name, ship_to_address1, ship_to_address2,
                    ship_to_city, ship_to_state, ship_to_postal_code, ship_to_country, ship_to_phone
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                returning id
            `,
            [
                access.accountName,
                accessRow.id,
                order.poNumber,
                order.shippingReference,
                order.contactName,
                order.contactPhone,
                order.requestedShipDate,
                order.orderNotes,
                order.shipToName,
                order.shipToAddress1,
                order.shipToAddress2,
                order.shipToCity,
                order.shipToState,
                order.shipToPostalCode,
                order.shipToCountry,
                order.shipToPhone
            ]
        );
        savedOrderId = insertResult.rows[0].id;
        await client.query(
            "update portal_orders set order_code = $2, updated_at = now() where id = $1",
            [savedOrderId, makePortalOrderCode(savedOrderId)]
        );
    }

    for (const [index, line] of order.lines.entries()) {
        await client.query(
            `
                insert into portal_order_lines (order_id, line_number, sku, requested_quantity)
                values ($1, $2, $3, $4)
            `,
            [savedOrderId, index + 1, line.sku, line.quantity]
        );
    }

    const savedOrder = await getPortalOrderById(client, savedOrderId, access.accountName, "/api/portal/order-documents");
    await insertActivity(
        client,
        "order",
        `${orderId ? "Updated" : "Created"} portal order ${savedOrder.orderCode}`,
        `${savedOrder.accountName} | ${formatCount(savedOrder.lines.length, "line")} | PO ${savedOrder.poNumber} | Requested ${savedOrder.requestedShipDate || "No ship date"}`
    );
    return savedOrder;
}

async function releasePortalOrder(client, accessRow, orderId) {
    const access = mapPortalAccessRow(accessRow);
    const order = await getPortalOrderById(client, orderId, access.accountName, "/api/portal/order-documents");
    if (!order) {
        throw httpError(404, "That order could not be found.");
    }
    if (order.status === "RELEASED") {
        return order;
    }
    if (order.status !== "DRAFT") {
        throw httpError(400, `Orders already marked ${order.status} cannot be released again from the company portal.`);
    }
    if (!order.lines.length) {
        throw httpError(400, "Add at least one line before releasing the order.");
    }

    for (const line of order.lines) {
        await assertPortalOrderSkuAllowed(client, access.accountName, line.sku, line.quantity);
    }

    await client.query(
        `
            update portal_orders
            set
                status = 'RELEASED',
                released_at = now(),
                updated_at = now()
            where id = $1
        `,
        [orderId]
    );

    const releasedOrder = await getPortalOrderById(client, orderId, access.accountName, "/api/portal/order-documents");
    await insertActivity(
        client,
        "order",
        `Released portal order ${releasedOrder.orderCode}`,
        `${releasedOrder.accountName} | ${formatCount(releasedOrder.lines.length, "line")} | ${releasedOrder.shippingReference || "No shipping reference"}`
    );
    return releasedOrder;
}

async function insertPortalOrderDocuments(client, orderId, documents, uploadedBy = "") {
    for (const document of documents) {
        await client.query(
            `
                insert into portal_order_documents (
                    order_id, file_name, file_type, file_size, file_data, uploaded_by
                )
                values ($1, $2, $3, $4, $5, $6)
            `,
            [
                orderId,
                document.fileName,
                document.fileType,
                document.fileSize,
                document.fileBuffer,
                normalizeFreeText(uploadedBy)
            ]
        );
    }
}

async function getPortalOrderDocumentById(documentId, client = pool) {
    const result = await client.query(
        `
            select
                d.*,
                o.account_name,
                o.order_code
            from portal_order_documents d
            join portal_orders o on o.id = d.order_id
            where d.id = $1
            limit 1
        `,
        [documentId]
    );
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function savePortalShippingConfirmation(client, order, rawConfirmation, appUser = null, { transitionToShipped = false } = {}) {
    const confirmation = sanitizePortalShippingConfirmationInput(rawConfirmation);
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    const confirmedShipDate = confirmation.confirmedShipDate || order.confirmedShipDate || normalizeDateInput(new Date());
    const shippedCarrierName = confirmation.shippedCarrierName || order.shippedCarrierName || "";
    const shippedTrackingReference = confirmation.shippedTrackingReference || order.shippedTrackingReference || "";
    const shippedConfirmationNote = confirmation.shippedConfirmationNote || order.shippedConfirmationNote || "";

    if (transitionToShipped) {
        await consumePortalOrderInventory(client, order);
    } else if (!confirmation.documents.length
        && confirmedShipDate === (order.confirmedShipDate || "")
        && shippedCarrierName === (order.shippedCarrierName || "")
        && shippedTrackingReference === (order.shippedTrackingReference || "")
        && shippedConfirmationNote === (order.shippedConfirmationNote || "")) {
        return order;
    }

    await client.query(
        `
            update portal_orders
            set
                status = $2,
                confirmed_ship_date = $3,
                shipped_carrier_name = $4,
                shipped_tracking_reference = $5,
                shipped_confirmation_note = $6,
                shipped_at = case when $7::boolean then coalesce(shipped_at, now()) else shipped_at end,
                updated_at = now()
            where id = $1
        `,
        [
            order.id,
            transitionToShipped ? "SHIPPED" : "SHIPPED",
            confirmedShipDate || null,
            shippedCarrierName,
            shippedTrackingReference,
            shippedConfirmationNote,
            transitionToShipped
        ]
    );

    if (confirmation.documents.length) {
        await insertPortalOrderDocuments(client, order.id, confirmation.documents, actor);
    }

    const updatedOrder = await getPortalOrderById(client, order.id, order.accountName);
    if (transitionToShipped) {
        await createPortalOrderBillingEvents(client, updatedOrder);
    }
    await insertActivity(
        client,
        "order",
        `${transitionToShipped ? "Shipped" : "Updated shipping confirmation for"} portal order ${updatedOrder.orderCode}`,
        [
            updatedOrder.accountName,
            shippedCarrierName ? `Carrier ${shippedCarrierName}` : "",
            shippedTrackingReference ? `Tracking ${shippedTrackingReference}` : "",
            confirmation.documents.length ? `${formatCount(confirmation.documents.length, "document")} uploaded` : "",
            actor
        ].filter(Boolean).join(" | ")
    );
    return updatedOrder;
}

async function assertPortalOrderSkuAllowed(client, accountName, sku, requestedQuantity = null) {
    const summary = await getPortalSkuAvailability(client, accountName, sku);

    if (summary.onHandQuantity <= 0) {
        throw httpError(400, `SKU ${normalizeText(sku)} is not currently available for that company.`);
    }
    if (requestedQuantity && Number(requestedQuantity) > summary.availableQuantity) {
        throw httpError(
            400,
            `SKU ${normalizeText(sku)} only has ${formatTrackedQuantity(summary.availableQuantity, summary.trackingLevel)} available right now.`
        );
    }
}

async function getPortalSkuAvailability(client, accountName, sku, excludeOrderId = null) {
    const normalizedAccount = normalizeText(accountName);
    const normalizedSku = normalizeText(sku);
    const params = [normalizedAccount, normalizedSku, ACTIVE_PORTAL_ORDER_STATUSES];
    let excludeSql = "";

    if (excludeOrderId) {
        params.push(excludeOrderId);
        excludeSql = ` and o.id <> $${params.length}`;
    }

    const result = await client.query(
        `
            with on_hand as (
                select
                    coalesce(sum(quantity), 0)::integer as on_hand_quantity,
                    coalesce(max(nullif(tracking_level, '')), 'UNIT') as tracking_level
                from inventory_lines
                where account_name = $1
                  and sku = $2
            ),
            reserved as (
                select coalesce(sum(l.requested_quantity), 0)::integer as reserved_quantity
                from portal_orders o
                join portal_order_lines l on l.order_id = o.id
                where o.account_name = $1
                  and l.sku = $2
                  and o.status = any($3::text[])
                  ${excludeSql}
            )
            select
                on_hand.on_hand_quantity,
                on_hand.tracking_level,
                coalesce(reserved.reserved_quantity, 0)::integer as reserved_quantity,
                greatest(on_hand.on_hand_quantity - coalesce(reserved.reserved_quantity, 0), 0)::integer as available_quantity
            from on_hand
            cross join reserved
        `,
        params
    );

    return {
        onHandQuantity: Number(result.rows[0]?.on_hand_quantity) || 0,
        reservedQuantity: Number(result.rows[0]?.reserved_quantity) || 0,
        availableQuantity: Number(result.rows[0]?.available_quantity) || 0,
        trackingLevel: result.rows[0]?.tracking_level || "UNIT"
    };
}

function mapPortalOrders(orderRows, lineRows, documentRows = [], downloadPathPrefix = "/api/admin/portal-order-documents", locationSummaries = new Map()) {
    const linesByOrderId = new Map();
    lineRows.forEach((row) => {
        const key = String(row.order_id);
        const locationKey = `${normalizeText(row.account_name)}::${normalizeText(row.sku)}`;
        if (!linesByOrderId.has(key)) linesByOrderId.set(key, []);
        linesByOrderId.get(key).push(mapPortalOrderLineRow(row, locationSummaries.get(locationKey)));
    });
    const documentsByOrderId = new Map();
    documentRows.forEach((row) => {
        const key = String(row.order_id);
        if (!documentsByOrderId.has(key)) documentsByOrderId.set(key, []);
        documentsByOrderId.get(key).push(row);
    });

    return orderRows.map((row) => mapPortalOrderRow(
        row,
        linesByOrderId.get(String(row.id)) || [],
        documentsByOrderId.get(String(row.id)) || [],
        downloadPathPrefix
    ));
}

function makePortalInboundCode(id) {
    return `INB-${String(id).padStart(6, "0")}`;
}

async function getPortalInboundsForAccount(accountName, client = pool) {
    const normalizedAccount = normalizeText(accountName);
    const inboundResult = await client.query(
        `
            select *
            from portal_inbounds
            where account_name = $1
            order by created_at desc, id desc
            limit 100
        `,
        [normalizedAccount]
    );
    const inboundIds = inboundResult.rows.map((row) => row.id);
    const linesResult = inboundIds.length
        ? await client.query(
            `
                select
                    l.*,
                    i.account_name,
                    c.description as item_description,
                    c.upc as item_upc,
                    c.tracking_level as item_tracking_level
                from portal_inbound_lines l
                join portal_inbounds i on i.id = l.inbound_id
                left join item_catalog c
                  on c.account_name = i.account_name
                 and c.sku = l.sku
                where l.inbound_id = any($1::bigint[])
                order by l.inbound_id desc, l.line_number asc, l.id asc
            `,
            [inboundIds]
        )
        : { rows: [] };
    return mapPortalInbounds(inboundResult.rows, linesResult.rows);
}

async function savePortalInbound(client, accessRow, rawInbound) {
    const access = mapPortalAccessRow(accessRow);
    const inbound = sanitizePortalInboundInput(rawInbound, access.accountName);

    if (!inbound.referenceNumber || !inbound.expectedDate || !inbound.contactName) {
        throw httpError(400, "Reference number, expected date, and contact name are required.");
    }
    if (!inbound.lines.length) {
        throw httpError(400, "Add at least one inbound line before submitting.");
    }
    for (const line of inbound.lines) {
        await assertPortalInboundSkuAllowed(client, access.accountName, line.sku);
    }

    const insertResult = await client.query(
        `
            insert into portal_inbounds (
                account_name, portal_access_id, reference_number, carrier_name,
                expected_date, contact_name, contact_phone, notes
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            returning id
        `,
        [
            access.accountName,
            accessRow.id,
            inbound.referenceNumber,
            inbound.carrierName,
            inbound.expectedDate,
            inbound.contactName,
            inbound.contactPhone,
            inbound.notes
        ]
    );
    const inboundId = insertResult.rows[0].id;
    await client.query(
        "update portal_inbounds set inbound_code = $2, updated_at = now() where id = $1",
        [inboundId, makePortalInboundCode(inboundId)]
    );

    for (const [index, line] of inbound.lines.entries()) {
        await client.query(
            `
                insert into portal_inbound_lines (inbound_id, line_number, sku, expected_quantity)
                values ($1, $2, $3, $4)
            `,
            [inboundId, index + 1, line.sku, line.quantity]
        );
    }

    const savedInbound = (await getPortalInboundsForAccount(access.accountName, client)).find((entry) => entry.id === inboundId);
    await insertActivity(
        client,
        "receipt",
        `Submitted portal inbound ${savedInbound.inboundCode}`,
        `${savedInbound.accountName} | ${formatCount(savedInbound.lines.length, "line")} | Ref ${savedInbound.referenceNumber}`
    );
    return savedInbound;
}

async function updateAdminPortalOrderStatus(client, orderId, nextStatus, details = {}, appUser = null) {
    const orderResult = await client.query("select * from portal_orders where id = $1 limit 1", [orderId]);
    if (orderResult.rowCount !== 1) {
        throw httpError(404, "That portal order could not be found.");
    }

    const currentOrder = await getPortalOrderById(client, orderId, orderResult.rows[0].account_name);
    if (!currentOrder) {
        throw httpError(404, "That portal order could not be found.");
    }
    if (currentOrder.status === nextStatus) {
        if (nextStatus === "SHIPPED") {
            return savePortalShippingConfirmation(client, currentOrder, details, appUser, { transitionToShipped: false });
        }
        return currentOrder;
    }

    const allowedTransitions = {
        RELEASED: "PICKED",
        PICKED: "STAGED",
        STAGED: "SHIPPED"
    };
    const allowedNext = allowedTransitions[currentOrder.status];
    if (!allowedNext || allowedNext !== nextStatus) {
        throw httpError(400, `Orders in ${currentOrder.status} can only move to ${allowedNext || "the next warehouse stage"}.`);
    }

    if (nextStatus === "SHIPPED") {
        return savePortalShippingConfirmation(client, currentOrder, details, appUser, { transitionToShipped: true });
    }

    const timestampColumn = nextStatus === "PICKED" ? "picked_at" : "staged_at";

    await client.query(
        `
            update portal_orders
            set
                status = $2,
                ${timestampColumn} = coalesce(${timestampColumn}, now()),
                updated_at = now()
            where id = $1
        `,
        [orderId, nextStatus]
    );

    const updatedOrder = await getPortalOrderById(client, orderId, currentOrder.accountName);
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    await insertActivity(
        client,
        "order",
        `Marked portal order ${updatedOrder.orderCode} ${nextStatus.toLowerCase()}`,
        `${updatedOrder.accountName} | ${formatCount(updatedOrder.lines.length, "line")} | ${actor}`
    );
    return updatedOrder;
}

async function consumePortalOrderInventory(client, order) {
    for (const line of order.lines) {
        let remaining = Number(line.quantity) || 0;
        if (remaining <= 0) continue;

        const result = await client.query(
            `
                select *
                from inventory_lines
                where account_name = $1
                  and sku = $2
                order by location asc, updated_at asc, id asc
            `,
            [normalizeText(order.accountName), normalizeText(line.sku)]
        );

        const available = result.rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
        if (available < remaining) {
            throw httpError(
                409,
                `Order ${order.orderCode} cannot be marked shipped because ${line.sku} only has ${formatTrackedQuantity(available, line.trackingLevel)} left on hand.`
            );
        }

        for (const inventoryLine of result.rows) {
            if (remaining <= 0) break;
            const currentQuantity = Number(inventoryLine.quantity) || 0;
            if (currentQuantity <= 0) continue;
            const deduction = Math.min(currentQuantity, remaining);
            await setInventoryQuantity(client, inventoryLine.id, currentQuantity - deduction);
            remaining -= deduction;
        }
    }
}

async function assertPortalInboundSkuAllowed(client, accountName, sku) {
    const normalizedAccount = normalizeText(accountName);
    const normalizedSku = normalizeText(sku);
    if (!normalizedAccount || !normalizedSku) {
        throw httpError(400, "SKU is required.");
    }
    const result = await client.query(
        `select 1 from item_catalog where account_name = $1 and sku = $2 limit 1`,
        [normalizedAccount, normalizedSku]
    );
    if (result.rowCount !== 1) {
        throw httpError(400, `SKU ${normalizedSku} is not available for your account.`);
    }
}

function mapPortalInbounds(inboundRows, lineRows) {
    const linesByInboundId = new Map();
    lineRows.forEach((row) => {
        const key = String(row.inbound_id);
        if (!linesByInboundId.has(key)) linesByInboundId.set(key, []);
        linesByInboundId.get(key).push(mapPortalInboundLineRow(row));
    });
    return inboundRows.map((row) => mapPortalInboundRow(row, linesByInboundId.get(String(row.id)) || []));
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

async function savePalletRecord(client, palletInput) {
    const entry = sanitizePalletRecordInput(palletInput);
    if (!entry || !entry.accountName || !entry.sku || !entry.cases || !entry.date) {
        throw httpError(400, "Company, SKU, cases on pallet, and date are required.");
    }

    const existing = entry.palletCode ? await getPalletRecordByCode(client, entry.palletCode) : null;
    const nextCode = existing?.palletCode || entry.palletCode || await generatePalletCode(client);
    const derived = await derivePalletInventorySettings(client, entry);

    if (existing && existing.location && existing.inventoryQuantity > 0) {
        await removeInventoryContribution(client, {
            accountName: existing.accountName,
            location: existing.location,
            sku: existing.sku,
            quantity: existing.inventoryQuantity
        });
    }

    if (entry.location) {
        await assertLocationCompatibleForOwner(client, entry.accountName, entry.location);
        if (derived.inventoryQuantity > 0) {
            await upsertInventoryLine(client, {
                accountName: entry.accountName,
                location: entry.location,
                sku: entry.sku,
                upc: derived.upc,
                quantity: derived.inventoryQuantity,
                trackingLevel: derived.inventoryTrackingLevel
            });
            await upsertLocationMaster(client, entry.location);
        }
    }

    await upsertOwnerMaster(client, entry.accountName);
    await upsertItemMaster(client, {
        accountName: entry.accountName,
        sku: entry.sku,
        upc: derived.upc,
        description: entry.description || derived.description,
        trackingLevel: derived.inventoryTrackingLevel,
        unitsPerCase: derived.unitsPerCase
    });

    const result = existing
        ? await client.query(
            `
                update pallet_records
                set
                    account_name = $2,
                    sku = $3,
                    upc = $4,
                    description = $5,
                    cases_on_pallet = $6,
                    label_date = $7,
                    location = $8,
                    inventory_tracking_level = $9,
                    inventory_quantity = $10,
                    updated_at = now()
                where pallet_code = $1
                returning *
            `,
            [
                existing.palletCode,
                entry.accountName,
                entry.sku,
                derived.upc,
                entry.description || derived.description,
                entry.cases,
                entry.date,
                entry.location,
                derived.inventoryTrackingLevel,
                derived.inventoryQuantity
            ]
        )
        : await client.query(
            `
                insert into pallet_records (
                    pallet_code, account_name, sku, upc, description,
                    cases_on_pallet, label_date, location,
                    inventory_tracking_level, inventory_quantity
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                returning *
            `,
            [
                nextCode,
                entry.accountName,
                entry.sku,
                derived.upc,
                entry.description || derived.description,
                entry.cases,
                entry.date,
                entry.location,
                derived.inventoryTrackingLevel,
                derived.inventoryQuantity
            ]
        );

    return mapPalletRecordRow(result.rows[0]);
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

async function removeInventoryContribution(client, item) {
    const accountName = normalizeText(item?.accountName);
    const location = normalizeText(item?.location);
    const sku = normalizeText(item?.sku);
    const quantity = toPositiveInt(item?.quantity);
    if (!accountName || !location || !sku || !quantity) return;

    const result = await client.query(
        "select * from inventory_lines where account_name = $1 and location = $2 and sku = $3 limit 1",
        [accountName, location, sku]
    );

    if (result.rowCount !== 1) {
        throw httpError(409, `Pallet inventory for ${accountName} / ${sku} at ${location} is missing and cannot be updated safely.`);
    }

    const line = result.rows[0];
    if (quantity > Number(line.quantity)) {
        throw httpError(409, `Pallet inventory for ${accountName} / ${sku} at ${location} was changed separately and cannot be reduced by ${formatTrackedQuantity(quantity, line.tracking_level)} safely.`);
    }

    await setInventoryQuantity(client, line.id, Number(line.quantity) - quantity);
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

async function upsertOwnerMaster(client, ownerInput, legacyNote = "") {
    const entry = typeof ownerInput === "object" && ownerInput !== null
        ? sanitizeOwnerMasterInput(ownerInput)
        : sanitizeOwnerMasterInput({ name: ownerInput, note: legacyNote });
    if (!entry?.name) return;

    await client.query(
        `
            insert into owner_accounts (
                name, note, legal_name, account_code, contact_name, contact_title,
                email, phone, mobile, website, billing_email, ap_email, portal_login_email,
                address1, address2, city, state, postal_code, country, is_active
            )
            values (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20
            )
            on conflict (name)
            do update set
                note = case when excluded.note <> '' then excluded.note else owner_accounts.note end,
                legal_name = case when excluded.legal_name <> '' then excluded.legal_name else owner_accounts.legal_name end,
                account_code = case when excluded.account_code <> '' then excluded.account_code else owner_accounts.account_code end,
                contact_name = case when excluded.contact_name <> '' then excluded.contact_name else owner_accounts.contact_name end,
                contact_title = case when excluded.contact_title <> '' then excluded.contact_title else owner_accounts.contact_title end,
                email = case when excluded.email <> '' then excluded.email else owner_accounts.email end,
                phone = case when excluded.phone <> '' then excluded.phone else owner_accounts.phone end,
                mobile = case when excluded.mobile <> '' then excluded.mobile else owner_accounts.mobile end,
                website = case when excluded.website <> '' then excluded.website else owner_accounts.website end,
                billing_email = case when excluded.billing_email <> '' then excluded.billing_email else owner_accounts.billing_email end,
                ap_email = case when excluded.ap_email <> '' then excluded.ap_email else owner_accounts.ap_email end,
                portal_login_email = case when excluded.portal_login_email <> '' then excluded.portal_login_email else owner_accounts.portal_login_email end,
                address1 = case when excluded.address1 <> '' then excluded.address1 else owner_accounts.address1 end,
                address2 = case when excluded.address2 <> '' then excluded.address2 else owner_accounts.address2 end,
                city = case when excluded.city <> '' then excluded.city else owner_accounts.city end,
                state = case when excluded.state <> '' then excluded.state else owner_accounts.state end,
                postal_code = case when excluded.postal_code <> '' then excluded.postal_code else owner_accounts.postal_code end,
                country = case when excluded.country <> '' then excluded.country else owner_accounts.country end,
                is_active = excluded.is_active,
                updated_at = now()
        `,
        [
            entry.name, entry.note, entry.legalName, entry.accountCode, entry.contactName, entry.contactTitle,
            entry.email, entry.phone, entry.mobile, entry.website, entry.billingEmail, entry.apEmail, entry.portalLoginEmail,
            entry.address1, entry.address2, entry.city, entry.state, entry.postalCode, entry.country, entry.isActive
        ]
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
        throw httpError(400, "Company and SKU are required.");
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
    const result = await client.query(
        "insert into activity_log (type, title, details) values ($1, $2, $3) returning *",
        [type, title, details]
    );
    return result.rows[0] ? mapActivityRow(result.rows[0]) : null;
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
        throw httpError(400, "Multiple items matched that UPC for the selected company and location. Use the SKU instead.");
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
            `Location ${location} already contains another company${conflictNames.length ? `: ${conflictNames.join(", ")}` : ""}. Mixed-company locations are not allowed.`
        );
    }
}

function buildItemConversionPlan({ accountName, fromLocation, toLocation, sourceLine, sourceMaster, targetMaster, sourceQuantity }) {
    const sourceSku = normalizeText(sourceLine?.sku);
    const sourceUpc = normalizeText(sourceLine?.upc || sourceMaster?.upc || "");
    const sourceTrackingLevel = normalizeTrackingLevel(sourceLine?.tracking_level || sourceMaster?.trackingLevel || "UNIT");
    const sourceUnitsPerCase = sourceMaster?.unitsPerCase == null ? null : Number(sourceMaster.unitsPerCase);
    const targetSku = normalizeText(targetMaster?.sku);
    const targetUpc = normalizeText(targetMaster?.upc || "");
    const targetTrackingLevel = normalizeTrackingLevel(targetMaster?.trackingLevel || "UNIT");
    const targetUnitsPerCase = targetMaster?.unitsPerCase == null ? null : Number(targetMaster.unitsPerCase);
    const targetDescription = normalizeFreeText(targetMaster?.description || "");

    if (!sourceSku || !targetSku) {
        throw httpError(400, "Both source and target items are required.");
    }
    if (sourceTrackingLevel === "PALLET" || targetTrackingLevel === "PALLET") {
        throw httpError(400, "Pallet-tracked items cannot be converted with this tool yet.");
    }

    const eachUnitCount = convertTrackedQuantityToEachUnits({
        quantity: sourceQuantity,
        trackingLevel: sourceTrackingLevel,
        unitsPerCase: sourceUnitsPerCase,
        itemLabel: `${accountName} / ${sourceSku}`
    });
    const targetQuantity = convertEachUnitsToTrackedQuantity({
        eachUnitCount,
        trackingLevel: targetTrackingLevel,
        unitsPerCase: targetUnitsPerCase,
        itemLabel: `${accountName} / ${targetSku}`
    });

    return {
        accountName,
        fromLocation,
        toLocation,
        sourceSku,
        sourceUpc,
        sourceTrackingLevel,
        sourceUnitsPerCase,
        sourceQuantity,
        targetSku,
        targetUpc,
        targetDescription,
        targetTrackingLevel,
        targetUnitsPerCase,
        targetQuantity,
        eachUnitCount
    };
}

function convertTrackedQuantityToEachUnits({ quantity, trackingLevel, unitsPerCase, itemLabel }) {
    const normalizedTracking = normalizeTrackingLevel(trackingLevel);
    const count = Number(quantity) || 0;
    if (count <= 0) {
        throw httpError(400, "Conversion quantity must be greater than zero.");
    }
    if (normalizedTracking === "UNIT") {
        return count;
    }
    if (normalizedTracking === "CASE") {
        if (!Number.isFinite(Number(unitsPerCase)) || Number(unitsPerCase) <= 0) {
            throw httpError(400, `Set units per case for ${itemLabel} before converting case-tracked inventory.`);
        }
        return count * Number(unitsPerCase);
    }
    throw httpError(400, `${itemLabel} uses an unsupported tracking level for conversion.`);
}

function convertEachUnitsToTrackedQuantity({ eachUnitCount, trackingLevel, unitsPerCase, itemLabel }) {
    const normalizedTracking = normalizeTrackingLevel(trackingLevel);
    const totalUnits = Number(eachUnitCount) || 0;
    if (totalUnits <= 0) {
        throw httpError(400, "Converted quantity must be greater than zero.");
    }
    if (normalizedTracking === "UNIT") {
        return totalUnits;
    }
    if (normalizedTracking === "CASE") {
        if (!Number.isFinite(Number(unitsPerCase)) || Number(unitsPerCase) <= 0) {
            throw httpError(400, `Set units per case for ${itemLabel} before converting into case-tracked inventory.`);
        }
        if (totalUnits % Number(unitsPerCase) !== 0) {
            throw httpError(400, `${totalUnits} units do not divide evenly into ${itemLabel} cases.`);
        }
        return totalUnits / Number(unitsPerCase);
    }
    throw httpError(400, `${itemLabel} uses an unsupported tracking level for conversion.`);
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
            throw httpError(400, "Multiple item masters matched that UPC for the selected company. Use the SKU instead.");
        }
        if (upcMatches.rowCount === 1) {
            return mapItemMasterRow(upcMatches.rows[0]);
        }
    }

    return null;
}

async function getPalletRecordByCode(client, palletCode) {
    const normalizedCode = normalizeText(palletCode);
    if (!normalizedCode) return null;
    const result = await client.query("select * from pallet_records where pallet_code = $1 limit 1", [normalizedCode]);
    return result.rowCount === 1 ? mapPalletRecordRow(result.rows[0]) : null;
}

async function generatePalletCode(client) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const palletCode = `PLT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        const existing = await client.query("select 1 from pallet_records where pallet_code = $1 limit 1", [palletCode]);
        if (existing.rowCount === 0) {
            return palletCode;
        }
    }
    throw httpError(500, "A unique pallet code could not be generated. Please try again.");
}

async function derivePalletInventorySettings(client, entry) {
    const master = await findCatalogItem(client, entry.accountName, entry.sku, entry.upc);
    const inventoryTrackingLevel = normalizeTrackingLevel(master?.trackingLevel || "CASE");
    const unitsPerCase = master?.unitsPerCase ?? null;
    let inventoryQuantity = 0;

    if (inventoryTrackingLevel === "PALLET") {
        inventoryQuantity = 1;
    } else if (inventoryTrackingLevel === "CASE") {
        inventoryQuantity = entry.cases;
    } else {
        if (!unitsPerCase) {
            throw httpError(400, `Set units per case for ${entry.accountName} / ${entry.sku} before saving pallet labels for a unit-tracked item.`);
        }
        inventoryQuantity = entry.cases * unitsPerCase;
    }

    return {
        upc: entry.upc || master?.upc || "",
        description: entry.description || master?.description || "",
        inventoryTrackingLevel,
        inventoryQuantity,
        unitsPerCase
    };
}

function groupInventoryInputs(lines) {
    const grouped = new Map();
    for (const rawLine of lines) {
        const line = sanitizeInventoryLineInput(rawLine);
        if (!line) {
            throw httpError(400, "Each batch line must include company, location, SKU, and positive quantity.");
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
            throw httpError(400, "Each item row must include Company and SKU.");
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
        legalName: normalizeFreeText(typeof item === "string" ? "" : item?.legalName || item?.legal_name),
        accountCode: normalizeText(typeof item === "string" ? "" : item?.accountCode || item?.account_code),
        contactName: normalizeFreeText(typeof item === "string" ? "" : item?.contactName || item?.contact_name),
        contactTitle: normalizeFreeText(typeof item === "string" ? "" : item?.contactTitle || item?.contact_title),
        email: normalizeEmail(typeof item === "string" ? "" : item?.email),
        phone: normalizeFreeText(typeof item === "string" ? "" : item?.phone),
        mobile: normalizeFreeText(typeof item === "string" ? "" : item?.mobile || item?.cell),
        website: normalizeFreeText(typeof item === "string" ? "" : item?.website),
        billingEmail: normalizeEmail(typeof item === "string" ? "" : item?.billingEmail || item?.billing_email),
        apEmail: normalizeEmail(typeof item === "string" ? "" : item?.apEmail || item?.ap_email),
        portalLoginEmail: normalizeEmail(typeof item === "string" ? "" : item?.portalLoginEmail || item?.portal_login_email || item?.portalEmail),
        address1: normalizeFreeText(typeof item === "string" ? "" : item?.address1 || item?.address_1),
        address2: normalizeFreeText(typeof item === "string" ? "" : item?.address2 || item?.address_2),
        city: normalizeFreeText(typeof item === "string" ? "" : item?.city),
        state: normalizeFreeText(typeof item === "string" ? "" : item?.state || item?.province),
        postalCode: normalizeText(typeof item === "string" ? "" : item?.postalCode || item?.postal_code || item?.zip),
        country: normalizeFreeText(typeof item === "string" ? "" : item?.country),
        isActive: typeof item === "string" ? true : item?.isActive !== false,
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

function sanitizePalletRecordInput(item) {
    const accountName = normalizeText(item?.accountName || item?.owner || item?.vendor || item?.customer || "");
    const sku = normalizeText(item?.sku);
    const cases = toPositiveInt(item?.cases ?? item?.casesOnPallet);
    const date = normalizeDateOnly(item?.date || item?.labelDate);
    const palletCode = normalizeText(item?.palletCode || item?.code || item?.pallet_id || item?.palletId || "");
    if (!accountName || !sku || !cases || !date) return null;
    return {
        palletCode,
        accountName,
        sku,
        upc: normalizeText(item?.upc || ""),
        description: normalizeFreeText(item?.description),
        cases,
        date,
        location: normalizeText(item?.location || ""),
        inventoryTrackingLevel: normalizeTrackingLevel(item?.inventoryTrackingLevel || item?.trackingLevel || "CASE"),
        inventoryQuantity: toPositiveInt(item?.inventoryQuantity) || 0,
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
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
        legalName: row.legal_name || "",
        accountCode: row.account_code || "",
        contactName: row.contact_name || "",
        contactTitle: row.contact_title || "",
        email: row.email || "",
        phone: row.phone || "",
        mobile: row.mobile || "",
        website: row.website || "",
        billingEmail: row.billing_email || "",
        apEmail: row.ap_email || "",
        portalLoginEmail: row.portal_login_email || "",
        address1: row.address1 || row.address_1 || row.address1 || "",
        address2: row.address2 || row.address_2 || "",
        city: row.city || "",
        state: row.state || "",
        postalCode: row.postal_code || "",
        country: row.country || "",
        isActive: row.is_active !== false,
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

function mapPalletRecordRow(row) {
    return {
        id: String(row.id),
        palletCode: row.pallet_code,
        accountName: row.account_name,
        sku: row.sku,
        upc: row.upc || "",
        description: row.description || "",
        cases: Number(row.cases_on_pallet) || 0,
        date: normalizeDateOnly(row.label_date),
        location: row.location || "",
        inventoryTrackingLevel: normalizeTrackingLevel(row.inventory_tracking_level),
        inventoryQuantity: Number(row.inventory_quantity) || 0,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapBillingFeeRow(row) {
    return {
        code: row.code,
        category: row.category || "",
        name: row.name || "",
        unitLabel: row.unit_label || "",
        defaultRate: roundBillingNumber(row.default_rate),
        isActive: row.is_active !== false,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
    };
}

function mapOwnerBillingRateRow(row) {
    return {
        id: String(row.id),
        accountName: row.account_name,
        feeCode: row.fee_code,
        rate: roundBillingNumber(row.rate),
        isEnabled: row.is_enabled === true,
        unitLabel: row.unit_label || "",
        note: row.note || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
    };
}

function mapBillingEventRow(row) {
    return {
        id: String(row.id),
        eventKey: row.event_key || "",
        accountName: row.account_name,
        feeCode: row.fee_code,
        feeCategory: row.fee_category || "",
        feeName: row.fee_name || "",
        unitLabel: row.unit_label || "",
        quantity: roundBillingNumber(row.quantity),
        rate: roundBillingNumber(row.rate),
        amount: roundBillingNumber(row.amount),
        currencyCode: row.currency_code || "USD",
        serviceDate: normalizeDateOnly(row.service_date),
        status: normalizeText(row.status || "OPEN"),
        invoiceNumber: row.invoice_number || "",
        invoicedAt: row.invoiced_at ? new Date(row.invoiced_at).toISOString() : null,
        sourceType: row.source_type || "",
        sourceRef: row.source_ref || "",
        reference: row.reference || "",
        note: row.note || "",
        metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
    };
}

function mapPortalAccessRow(row) {
    return {
        id: String(row.id),
        accountName: row.account_name,
        email: row.email || "",
        isActive: row.is_active === true,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapPortalInventoryRow(row) {
    return {
        accountName: row.account_name,
        sku: row.sku,
        upc: row.upc || "",
        description: row.description || "",
        imageUrl: row.image_url || "",
        trackingLevel: normalizeTrackingLevel(row.tracking_level),
        totalQuantity: Number(row.total_quantity) || 0,
        onHandQuantity: Number(row.on_hand_quantity) || Number(row.total_quantity) || 0,
        reservedQuantity: Number(row.reserved_quantity) || 0,
        availableQuantity: Number(row.available_quantity) || Number(row.total_quantity) || 0,
        locationCount: Number(row.location_count) || 0,
        locations: Array.isArray(row.locations) ? row.locations.filter(Boolean) : []
    };
}

function mapPortalItemRow(row) {
    return {
        id: String(row.id),
        accountName: row.account_name,
        sku: row.sku || "",
        upc: row.upc || "",
        description: row.description || "",
        trackingLevel: normalizeTrackingLevel(row.tracking_level),
        unitsPerCase: row.units_per_case == null ? null : Number(row.units_per_case),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

function mapPortalOrderRow(row, lines = [], documents = [], downloadPathPrefix = "/api/admin/portal-order-documents") {
    return {
        id: String(row.id),
        orderCode: row.order_code || makePortalOrderCode(row.id),
        accountName: row.account_name,
        status: String(row.status || "DRAFT").toUpperCase(),
        poNumber: row.po_number || "",
        shippingReference: row.shipping_reference || "",
        contactName: row.contact_name || "",
        contactPhone: row.contact_phone || "",
        requestedShipDate: row.requested_ship_date ? normalizeDateOnly(row.requested_ship_date) : "",
        orderNotes: row.order_notes || "",
        shipToName: row.ship_to_name || "",
        shipToAddress1: row.ship_to_address1 || "",
        shipToAddress2: row.ship_to_address2 || "",
        shipToCity: row.ship_to_city || "",
        shipToState: row.ship_to_state || "",
        shipToPostalCode: row.ship_to_postal_code || "",
        shipToCountry: row.ship_to_country || "",
        shipToPhone: row.ship_to_phone || "",
        confirmedShipDate: row.confirmed_ship_date ? normalizeDateOnly(row.confirmed_ship_date) : "",
        shippedCarrierName: row.shipped_carrier_name || "",
        shippedTrackingReference: row.shipped_tracking_reference || "",
        shippedConfirmationNote: row.shipped_confirmation_note || "",
        releasedAt: row.released_at ? new Date(row.released_at).toISOString() : null,
        pickedAt: row.picked_at ? new Date(row.picked_at).toISOString() : null,
        stagedAt: row.staged_at ? new Date(row.staged_at).toISOString() : null,
        shippedAt: row.shipped_at ? new Date(row.shipped_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        lines,
        documents: documents.map((document) => mapPortalOrderDocumentRow(document, downloadPathPrefix))
    };
}

function mapPortalOrderLineRow(row, locationSummary = null) {
    const normalizedLocations = Array.isArray(locationSummary?.locations)
        ? locationSummary.locations.map((entry) => ({
            location: entry.location || "",
            quantity: Number(entry.quantity) || 0,
            trackingLevel: normalizeTrackingLevel(entry.trackingLevel || locationSummary?.trackingLevel || row.item_tracking_level || "UNIT")
        })).filter((entry) => entry.location)
        : [];

    return {
        id: String(row.id),
        orderId: String(row.order_id),
        lineNumber: Number(row.line_number) || 0,
        sku: row.sku,
        quantity: Number(row.requested_quantity) || 0,
        description: row.item_description || "",
        upc: row.item_upc || "",
        trackingLevel: normalizeTrackingLevel(row.item_tracking_level),
        onHandQuantity: Number(locationSummary?.onHandQuantity) || 0,
        availableQuantity: Number(locationSummary?.availableQuantity) || 0,
        pickLocations: normalizedLocations,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapPortalOrderDocumentRow(row, downloadPathPrefix = "/api/admin/portal-order-documents") {
    return {
        id: String(row.id),
        orderId: String(row.order_id),
        fileName: row.file_name || "Document",
        fileType: row.file_type || "application/octet-stream",
        fileSize: Number(row.file_size) || 0,
        uploadedBy: row.uploaded_by || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        downloadUrl: `${downloadPathPrefix}/${row.id}`
    };
}

function mapPortalInboundRow(row, lines = []) {
    return {
        id: Number(row.id),
        inboundCode: row.inbound_code || makePortalInboundCode(row.id),
        accountName: row.account_name || "",
        status: row.status || "SUBMITTED",
        referenceNumber: row.reference_number || "",
        carrierName: row.carrier_name || "",
        expectedDate: row.expected_date ? new Date(row.expected_date).toISOString().slice(0, 10) : "",
        contactName: row.contact_name || "",
        contactPhone: row.contact_phone || "",
        notes: row.notes || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        lines
    };
}

function mapPortalInboundLineRow(row) {
    return {
        id: Number(row.id),
        lineNumber: Number(row.line_number || 0),
        sku: row.sku || "",
        quantity: Number(row.expected_quantity || 0),
        description: row.item_description || "",
        upc: row.item_upc || "",
        trackingLevel: row.item_tracking_level || "UNIT"
    };
}

function sanitizePortalInboundInput(inbound, accountName) {
    const lines = Array.isArray(inbound?.lines)
        ? inbound.lines.map((line) => ({
            sku: normalizeText(line?.sku),
            quantity: toPositiveInt(line?.quantity)
        })).filter((line) => line.sku && line.quantity > 0)
        : [];

    return {
        accountName: normalizeText(accountName),
        referenceNumber: normalizeFreeText(inbound?.referenceNumber || inbound?.reference || inbound?.poNumber),
        carrierName: normalizeFreeText(inbound?.carrierName || inbound?.carrier),
        expectedDate: normalizeDateInput(inbound?.expectedDate),
        contactName: normalizeFreeText(inbound?.contactName),
        contactPhone: normalizeFreeText(inbound?.contactPhone),
        notes: normalizeFreeText(inbound?.notes),
        lines
    };
}

function sanitizePortalOrderInput(order, accountName) {
    return {
        accountName: normalizeText(accountName),
        poNumber: normalizeFreeText(order?.poNumber),
        shippingReference: normalizeFreeText(order?.shippingReference),
        contactName: normalizeFreeText(order?.contactName),
        contactPhone: normalizeFreeText(order?.contactPhone),
        requestedShipDate: normalizeDateInput(order?.requestedShipDate || order?.shipDate),
        orderNotes: normalizeFreeText(order?.orderNotes || order?.notes),
        shipToName: normalizeFreeText(order?.shipToName),
        shipToAddress1: normalizeFreeText(order?.shipToAddress1),
        shipToAddress2: normalizeFreeText(order?.shipToAddress2),
        shipToCity: normalizeFreeText(order?.shipToCity),
        shipToState: normalizeFreeText(order?.shipToState),
        shipToPostalCode: normalizeFreeText(order?.shipToPostalCode),
        shipToCountry: normalizeFreeText(order?.shipToCountry || "USA"),
        shipToPhone: normalizeFreeText(order?.shipToPhone || order?.phone || order?.shipPhone),
        lines: groupPortalOrderLines(Array.isArray(order?.lines) ? order.lines : [])
    };
}

function sanitizePortalShippingConfirmationInput(payload) {
    return {
        confirmedShipDate: normalizeDateInput(payload?.confirmedShipDate || payload?.shipDate || payload?.actualShipDate),
        shippedCarrierName: normalizeFreeText(payload?.shippedCarrierName || payload?.carrierName || payload?.carrier),
        shippedTrackingReference: normalizeFreeText(
            payload?.shippedTrackingReference
            || payload?.trackingNumber
            || payload?.trackingReference
            || payload?.proNumber
            || payload?.bolNumber
        ),
        shippedConfirmationNote: normalizeFreeText(payload?.shippedConfirmationNote || payload?.shippingNote || payload?.note),
        documents: sanitizePortalOrderDocumentsInput(Array.isArray(payload?.documents) ? payload.documents : [])
    };
}

function sanitizePortalOrderDocumentsInput(documents) {
    return documents.map(sanitizePortalOrderDocumentInput).filter(Boolean);
}

function sanitizePortalOrderDocumentInput(document) {
    if (!document || typeof document !== "object") return null;
    const fileName = normalizeUploadFileName(document.fileName || document.name || document.filename);
    const dataUrl = String(document.dataUrl || document.data || "").trim();
    if (!fileName && !dataUrl) return null;
    if (!fileName || !dataUrl) {
        throw httpError(400, "Each shipped document must include a file and file name.");
    }

    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) {
        throw httpError(400, `${fileName} could not be processed. Upload a PDF or image file.`);
    }

    const fileType = String(document.fileType || match[1] || "application/octet-stream").trim().toLowerCase();
    if (!(fileType === "application/pdf" || fileType.startsWith("image/"))) {
        throw httpError(400, `${fileName} must be a PDF or image file.`);
    }

    const base64 = match[2].replace(/\s+/g, "");
    if (!base64) {
        throw httpError(400, `${fileName} did not contain file data.`);
    }

    let buffer;
    try {
        buffer = Buffer.from(base64, "base64");
    } catch (_error) {
        throw httpError(400, `${fileName} could not be decoded.`);
    }

    if (!buffer.length) {
        throw httpError(400, `${fileName} did not contain file data.`);
    }
    if (buffer.length > 4 * 1024 * 1024) {
        throw httpError(400, `${fileName} is too large. Keep each shipped document under 4 MB.`);
    }

    return {
        fileName,
        fileType,
        fileSize: buffer.length,
        fileBuffer: buffer
    };
}

function normalizeUploadFileName(value) {
    return String(value || "")
        .trim()
        .replace(/^.*[\\/]/, "")
        .replace(/[^\w.\- ()[\]]+/g, "_")
        .slice(0, 160);
}

function normalizePortalOrderStatus(value) {
    const normalized = normalizeText(value);
    return ["DRAFT", "RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(normalized) ? normalized : "";
}

function groupPortalOrderLines(lines) {
    const grouped = new Map();
    for (const rawLine of lines) {
        const line = sanitizePortalOrderLineInput(rawLine);
        if (!line) continue;
        const current = grouped.get(line.sku) || { sku: line.sku, quantity: 0 };
        current.quantity += line.quantity;
        grouped.set(line.sku, current);
    }
    return [...grouped.values()];
}

function sanitizePortalOrderLineInput(line) {
    const sku = normalizeText(line?.sku);
    const quantity = toPositiveInt(line?.quantity ?? line?.requestedQuantity);
    if (!sku && !quantity) return null;
    if (!sku || !quantity) {
        throw httpError(400, "Each order line must include a SKU and quantity.");
    }
    return { sku, quantity };
}

function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeDateOnly(value) {
    if (!value) return "";
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const text = String(value).trim();
    const direct = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (direct) {
        return `${direct[1]}-${direct[2]}-${direct[3]}`;
    }
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
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

function createUnavailablePool(message) {
    const errorFactory = () => httpError(503, message);
    return {
        query: async () => { throw errorFactory(); },
        connect: async () => { throw errorFactory(); },
        on: () => {}
    };
}

function assertDatabaseAvailable() {
    if (!DATABASE_URL) {
        throw httpError(503, databaseErrorMessage || "Database is not configured yet.");
    }
    if (!databaseReady) {
        throw httpError(503, databaseErrorMessage || "Database is still starting up. Please try again.");
    }
}

function isPublicRequest(req) {
    const pathName = req.path || req.url || "";
    if (!pathName) return false;
    if (pathName === "/api/health") return true;
    if (pathName === "/" || pathName === "/index.html") return true;
    if (pathName === "/login" || pathName === "/login.html") return true;
    if (pathName === "/portal" || pathName === "/portal.html") return true;
    if (pathName === "/favicon.ico") return true;
    return false;
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

function hashPortalPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${derived}`;
}

function verifyPortalPassword(password, storedHash) {
    const [salt, hash] = String(storedHash || "").split(":");
    if (!salt || !hash) return false;
    const storedBuffer = Buffer.from(hash, "hex");
    const derivedBuffer = crypto.scryptSync(password, salt, storedBuffer.length);
    if (storedBuffer.length !== derivedBuffer.length) return false;
    return crypto.timingSafeEqual(storedBuffer, derivedBuffer);
}

function hashPortalSessionToken(token) {
    return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function parseCookies(cookieHeader) {
    return String(cookieHeader || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const separatorIndex = part.indexOf("=");
            if (separatorIndex < 0) return cookies;
            const key = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1).trim();
            cookies[key] = decodeURIComponent(value);
            return cookies;
        }, {});
}

function isSecureRequest(req) {
    if (req.secure) return true;
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    return forwardedProto === "https";
}

function setAppSessionCookie(res, token, req) {
    const parts = [
        `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${APP_SESSION_MAX_AGE}`
    ];
    if (isSecureRequest(req)) {
        parts.push("Secure");
    }
    res.append("Set-Cookie", parts.join("; "));
}

function clearAppSessionCookie(res, req) {
    const parts = [
        `${APP_SESSION_COOKIE}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0"
    ];
    if (isSecureRequest(req)) {
        parts.push("Secure");
    }
    res.append("Set-Cookie", parts.join("; "));
}

function setPortalSessionCookie(res, token, req) {
    const parts = [
        `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${PORTAL_SESSION_MAX_AGE}`
    ];
    if (isSecureRequest(req)) {
        parts.push("Secure");
    }
    res.append("Set-Cookie", parts.join("; "));
}

function clearPortalSessionCookie(res, req) {
    const parts = [
        `${PORTAL_SESSION_COOKIE}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0"
    ];
    if (isSecureRequest(req)) {
        parts.push("Secure");
    }
    res.append("Set-Cookie", parts.join("; "));
}

function makePortalOrderCode(orderId) {
    return `ORD-${String(orderId).padStart(6, "0")}`;
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
