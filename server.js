const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");
const { Pool } = require("pg");
let Stripe = null;
try {
    Stripe = require("stripe");
} catch (_error) {
    Stripe = null;
}
let SftpClient = null;
try {
    SftpClient = require("ssh2-sftp-client");
} catch (_error) {
    SftpClient = null;
}


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

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function stripEnvWrappingQuotes(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).trim();
    }
    return text;
}

function readEnv(name, fallback = "") {
    const value = Object.prototype.hasOwnProperty.call(process.env, name)
        ? process.env[name]
        : fallback;
    return stripEnvWrappingQuotes(value);
}

const normalizeEmail = bootstrapNormalizeEmail;
const normalizeFreeText = bootstrapNormalizeFreeText;

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ROOT_DIR = __dirname;
const APP_BUILD_FILES = [
    "package.json",
    "server.js",
    "marketing.css",
    "marketing.js",
    "marketing-logo.svg",
    "site.webmanifest",
    "hero-warehouse-scene.svg",
    "industry-3pl-scene.svg",
    "industry-ecommerce-scene.svg",
    "industry-lot-control-scene.svg",
    "site.html",
    "pricing.html",
    "industries.html",
    "book-demo.html",
    "integrations.html",
    "implementation.html",
    "3pl-warehouse-management-software.html",
    "shopify-warehouse-management-software.html",
    "lot-tracking-expiration-date-inventory-software.html",
    "customer-portal-for-3pl-warehouses.html",
    "sftp-warehouse-integration-software.html",
    "robots.txt",
    "sitemap.xml",
    "index.html",
    "portal.html",
    "login.html",
    "mobile-pick.html"
];
const APP_BUILD_INFO = createAppBuildInfo(ROOT_DIR, APP_BUILD_FILES);
const DATABASE_URL = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL") || "";
const LEGACY_ACCOUNT = "LEGACY";
const PORTAL_SESSION_COOKIE = "wms365_portal_session";
const APP_SESSION_COOKIE = "wms365_app_session";
const PORTAL_SESSION_TTL_DAYS = 14;
const APP_SESSION_TTL_DAYS = 14;
const PORTAL_SESSION_MAX_AGE = PORTAL_SESSION_TTL_DAYS * 24 * 60 * 60;
const APP_SESSION_MAX_AGE = APP_SESSION_TTL_DAYS * 24 * 60 * 60;
const DEFAULT_ADMIN_EMAIL = bootstrapNormalizeEmail(readEnv("APP_ADMIN_EMAIL", "admin@wms365.local"));
const DEFAULT_ADMIN_PASSWORD = readEnv("APP_ADMIN_PASSWORD", "ChangeMeNow123!");
const DEFAULT_ADMIN_NAME = bootstrapNormalizeFreeText(readEnv("APP_ADMIN_NAME", "Platform Owner"));
const DEMO_REQUEST_TO = bootstrapNormalizeEmail(readEnv("DEMO_REQUEST_TO", DEFAULT_ADMIN_EMAIL || ""));
const ADMIN_ACTIVITY_SUMMARY_TO = bootstrapNormalizeEmail(readEnv("ADMIN_ACTIVITY_SUMMARY_TO", DEFAULT_ADMIN_EMAIL || ""));
const PUBLIC_SITE_URL = readEnv("PUBLIC_SITE_URL", "").replace(/\/+$/, "");
const PUBLIC_SITE_ALLOWED_ORIGINS = readEnv("PUBLIC_SITE_ALLOWED_ORIGINS", "");
const STRIPE_SECRET_KEY = readEnv("STRIPE_SECRET_KEY", "");
const STRIPE_WEBHOOK_SECRET = readEnv("STRIPE_WEBHOOK_SECRET", "");
const STRIPE_PRICE_LAUNCH_WAREHOUSE = readEnv("STRIPE_PRICE_LAUNCH_WAREHOUSE", "");
const STRIPE_PRICE_CUSTOMER_FACING = readEnv("STRIPE_PRICE_CUSTOMER_FACING", "");
const SMTP_HOST = readEnv("SMTP_HOST", "");
const SMTP_PORT = Number.parseInt(readEnv("SMTP_PORT", "0") || "0", 10) || 0;
const SMTP_SECURE = /^(1|true|yes|on)$/i.test(readEnv("SMTP_SECURE", ""));
const SMTP_USER = readEnv("SMTP_USER", "");
const SMTP_PASS = readEnv("SMTP_PASS", "");
const SMTP_FROM = readEnv("SMTP_FROM", "");
const SMTP_REPLY_TO = readEnv("SMTP_REPLY_TO", "");
const ORDER_RELEASE_TO = readEnv("ORDER_RELEASE_TO", "");
const ADMIN_ACTIVITY_DIGEST_JOB_KEY = "ADMIN_ACTIVITY_DIGEST";
const ADMIN_ACTIVITY_DIGEST_TIME_ZONE = "America/New_York";
const ADMIN_ACTIVITY_DIGEST_HOUR = 21;
const ADMIN_ACTIVITY_DIGEST_MINUTE = 0;
const ADMIN_ACTIVITY_DIGEST_SCHEDULER_INTERVAL_MS = 60 * 1000;
const ACTIVE_PORTAL_ORDER_STATUSES = ["RELEASED", "PICKED", "STAGED"];
const STORE_INTEGRATION_PROVIDERS = ["SHOPIFY", "SFTP", "WOOCOMMERCE", "BIGCOMMERCE", "AMAZON", "ETSY", "CUSTOM_API"];
const STORE_INTEGRATION_IMPORT_STATUSES = ["DRAFT", "RELEASED"];
const STORE_INTEGRATION_SYNC_STATUSES = ["IDLE", "SUCCESS", "WARNING", "ERROR"];
const STORE_INTEGRATION_SYNC_SCHEDULES = ["MANUAL", "EVERY_5_MINUTES", "EVERY_15_MINUTES", "EVERY_30_MINUTES", "HOURLY", "DAILY_0900", "DAILY_1200", "DAILY_1500", "DAILY_1800"];
const SHOPIFY_SYNC_PROVIDER = "SHOPIFY";
const SFTP_SYNC_PROVIDER = "SFTP";
const FEEDBACK_REQUEST_TYPES = ["BUG", "FEATURE", "OTHER"];
const FEEDBACK_SOURCES = ["WAREHOUSE", "PORTAL"];
const FEEDBACK_STATUSES = ["NEW", "REVIEWING", "PLANNED", "FIXED", "CLOSED"];
const SITE_SUBSCRIPTION_STATUSES = ["PENDING", "TRIALING", "ACTIVE", "PAST_DUE", "UNPAID", "INCOMPLETE", "INCOMPLETE_EXPIRED", "CANCELED", "PAUSED"];
const SITE_SUBSCRIPTION_BILLING_STATUSES = ["PENDING", "PAID", "PAYMENT_FAILED", "PAST_DUE", "CANCELED"];
const SITE_SUBSCRIPTION_PROVISIONING_STATUSES = ["PENDING_REVIEW", "OWNER_CREATED"];
const SHOPIFY_ADMIN_API_VERSION = "2026-01";
const SHOPIFY_ORDER_PAGE_LIMIT = 250;
const STRIPE_CHECKOUT_PLANS = Object.freeze({
    LAUNCH_WAREHOUSE: {
        key: "LAUNCH_WAREHOUSE",
        label: "Launch Warehouse",
        marketingPriceLabel: "$129 / month",
        priceId: STRIPE_PRICE_LAUNCH_WAREHOUSE,
        mode: "subscription",
        selfServe: true,
        successPath: "/pricing?checkout=success&plan=launch-warehouse",
        cancelPath: "/pricing?checkout=cancelled&plan=launch-warehouse"
    },
    CUSTOMER_FACING_OPERATION: {
        key: "CUSTOMER_FACING_OPERATION",
        label: "Customer-Facing Operation",
        marketingPriceLabel: "Custom quote",
        priceId: STRIPE_PRICE_CUSTOMER_FACING,
        mode: "subscription",
        selfServe: false,
        successPath: "/pricing?checkout=success&plan=customer-facing-operation",
        cancelPath: "/pricing?checkout=cancelled&plan=customer-facing-operation"
    }
});
const PUBLIC_API_CORS_PATHS = new Set([
    "/api/version",
    "/api/site/demo-request",
    "/api/site/stripe-config",
    "/api/site/stripe-checkout",
    "/api/site/stripe-checkout-session"
]);
const PUBLIC_API_ALLOWED_ORIGINS = buildPublicApiAllowedOrigins();
const COMPANY_FEATURE_KEYS = Object.freeze({
    CUSTOMER_PORTAL: "CUSTOMER_PORTAL",
    ORDER_ENTRY: "ORDER_ENTRY",
    INBOUND_NOTICES: "INBOUND_NOTICES",
    BILLING: "BILLING",
    STORE_INTEGRATIONS: "STORE_INTEGRATIONS",
    SHOPIFY_INTEGRATION: "SHOPIFY_INTEGRATION",
    SFTP_INTEGRATION: "SFTP_INTEGRATION"
});
const COMPANY_FEATURE_CATALOG = Object.freeze([
    {
        key: COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL,
        label: "Customer Portal",
        description: "Allow the company to sign in to the customer portal, review inventory, export reports, and maintain item masters."
    },
    {
        key: COMPANY_FEATURE_KEYS.ORDER_ENTRY,
        label: "Sales Orders",
        description: "Allow warehouse and customer-driven sales order entry, release, and order workflow for this company."
    },
    {
        key: COMPANY_FEATURE_KEYS.INBOUND_NOTICES,
        label: "Purchase Orders",
        description: "Allow expected receipt and purchase order workflows from the warehouse and customer portal."
    },
    {
        key: COMPANY_FEATURE_KEYS.BILLING,
        label: "Billing",
        description: "Allow company-specific billing setup, manual billing lines, storage accruals, and invoice state changes."
    },
    {
        key: COMPANY_FEATURE_KEYS.STORE_INTEGRATIONS,
        label: "Store Integrations",
        description: "Allow this company to use storefront and file integrations from the warehouse desktop."
    },
    {
        key: COMPANY_FEATURE_KEYS.SHOPIFY_INTEGRATION,
        label: "Shopify",
        description: "Allow Shopify order import and sync under the company integration workspace."
    },
    {
        key: COMPANY_FEATURE_KEYS.SFTP_INTEGRATION,
        label: "SFTP",
        description: "Allow SFTP scheduled import/export lanes for this company."
    }
]);
const DEFAULT_NEW_COMPANY_FEATURE_FLAGS = Object.freeze({
    [COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL]: false,
    [COMPANY_FEATURE_KEYS.ORDER_ENTRY]: true,
    [COMPANY_FEATURE_KEYS.INBOUND_NOTICES]: true,
    [COMPANY_FEATURE_KEYS.BILLING]: false,
    [COMPANY_FEATURE_KEYS.STORE_INTEGRATIONS]: false,
    [COMPANY_FEATURE_KEYS.SHOPIFY_INTEGRATION]: false,
    [COMPANY_FEATURE_KEYS.SFTP_INTEGRATION]: false
});
const LEGACY_COMPANY_FEATURE_FLAGS = Object.freeze(
    COMPANY_FEATURE_CATALOG.reduce((accumulator, feature) => {
        accumulator[feature.key] = true;
        return accumulator;
    }, {})
);
const STORE_INTEGRATION_SCHEDULER_INTERVAL_MS = 60 * 1000;
const SFTP_DEFAULT_PORT = 22;
const SFTP_DEFAULT_ARCHIVE_FOLDER = "/archive";
const STORE_INTEGRATION_INTERVAL_SCHEDULE_MS = Object.freeze({
    EVERY_5_MINUTES: 5 * 60 * 1000,
    EVERY_15_MINUTES: 15 * 60 * 1000,
    EVERY_30_MINUTES: 30 * 60 * 1000,
    HOURLY: 60 * 60 * 1000
});
const STORE_INTEGRATION_DAILY_SCHEDULE_TIMES = Object.freeze({
    DAILY_0900: { hour: 9, minute: 0 },
    DAILY_1200: { hour: 12, minute: 0 },
    DAILY_1500: { hour: 15, minute: 0 },
    DAILY_1800: { hour: 18, minute: 0 }
});
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
let shipmentMailer = null;
let systemMailer = null;
let stripeClient = null;
let storeIntegrationSchedulerStarted = false;
let storeIntegrationSchedulerRunning = false;
let storeIntegrationSchedulerTimer = null;
let adminActivityDigestSchedulerStarted = false;
let adminActivityDigestSchedulerRunning = false;
let adminActivityDigestSchedulerTimer = null;
const storeIntegrationSyncLocks = new Set();

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

app.use((req, res, next) => {
    const pathName = req.path || req.url || "";
    if (!PUBLIC_API_CORS_PATHS.has(pathName)) {
        return next();
    }

    const originAllowed = applyPublicApiCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
        if (!originAllowed && req.get("origin")) {
            return res.status(403).json({ error: "This origin is not allowed for the public site API." });
        }
        return res.status(204).end();
    }

    if (!originAllowed && req.get("origin")) {
        return next(httpError(403, "This origin is not allowed for the public site API."));
    }
    return next();
});

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
            return { token, user: await attachAppUserCompanyAssignments(client, await getAppUserById(client, user.id)) };
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

app.post("/api/app/feedback", async (req, res, next) => {
    try {
        assertDatabaseAvailable();
        const feedback = await withTransaction((client) => saveFeedbackSubmission(client, req.body, {
            source: "WAREHOUSE",
            accountName: req.body?.accountName || "",
            submittedByEmail: req.appUser?.email || "",
            submittedByName: req.appUser?.full_name || req.appUser?.email || "",
            submittedByRole: req.appUser?.role || "",
            buildLabel: req.body?.buildLabel || APP_BUILD_INFO.label || "",
            ipAddress: req.ip || ""
        }));
        res.status(201).json({ success: true, feedback });
    } catch (error) {
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

app.get("/api/version", (_req, res) => {
    res.status(200).json({
        ok: true,
        app: "WMS365 Scanner",
        build: APP_BUILD_INFO
    });
});

app.post("/api/admin/system-email/daily-summary/send-now", async (req, res, next) => {
    try {
        assertSuperAdminAccess(req.appUser);
        assertDatabaseAvailable();
        if (!ADMIN_ACTIVITY_SUMMARY_TO) {
            throw httpError(400, "No admin summary recipient is configured. Set ADMIN_ACTIVITY_SUMMARY_TO or APP_ADMIN_EMAIL first.");
        }
        const now = new Date();
        const digest = await buildAdminActivityDigest(getTimeZoneDateKey(now, ADMIN_ACTIVITY_DIGEST_TIME_ZONE), { now });
        await sendAdminActivityDigestEmail(digest);
        res.json({
            success: true,
            recipient: ADMIN_ACTIVITY_SUMMARY_TO,
            dateKey: digest.dateKey,
            generatedAt: digest.generatedAt
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/site/demo-request", async (req, res, next) => {
    try {
        assertDatabaseAvailable();
        const payload = sanitizeSiteDemoRequestInput(req.body);
        if (payload.website) {
            return res.status(202).json({ success: true, requestId: null, emailed: false });
        }

        const savedRequest = await withTransaction(async (client) => {
            const created = await saveSiteDemoRequest(client, payload, {
                sourcePage: req.body?.sourcePage || req.get("referer") || "/",
                browserLocale: req.body?.browserLocale || "",
                ipAddress: req.ip || "",
                userAgent: req.get("user-agent") || ""
            });
            await insertActivity(
                client,
                "marketing",
                `Demo request from ${created.companyName}`,
                [created.fullName, created.workEmail, created.interestSummary].filter(Boolean).join(" | ")
            );
            return created;
        });

        let emailed = false;
        try {
            emailed = (await sendDemoRequestNotification(savedRequest)).length > 0;
        } catch (error) {
            console.error("Failed to send demo request notification:", error.message || error);
        }

        res.status(201).json({
            success: true,
            requestId: savedRequest.id,
            emailed
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/site/stripe-config", (_req, res) => {
    res.json({
        ok: true,
        enabled: hasStripeCheckoutConfig(),
        plans: getStripeCheckoutPlanSummaries()
    });
});

app.get("/api/site/stripe-checkout-session", async (req, res, next) => {
    try {
        const checkoutSessionId = normalizeStripeCheckoutSessionId(req.query?.sessionId || req.query?.session_id);
        if (!checkoutSessionId) {
            throw httpError(400, "A valid Stripe checkout session id is required.");
        }
        const summary = await getStripeCheckoutSessionSummary(checkoutSessionId);
        res.json({
            success: true,
            checkoutSession: summary
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/site/stripe-checkout", async (req, res, next) => {
    try {
        const planKey = normalizeStripeCheckoutPlanKey(req.body?.planKey || req.body?.plan || req.body?.priceKey);
        const checkoutInput = sanitizeStripeCheckoutLeadInput(req.body, { planKey });
        const session = await createStripeCheckoutSessionForSite(req, {
            planKey,
            customerEmail: checkoutInput.workEmail,
            fullName: checkoutInput.fullName,
            companyName: checkoutInput.companyName,
            sourcePage: checkoutInput.sourcePage || req.get("referer") || ""
        });
        await withTransaction(async (client) => {
            await upsertSiteSubscriptionRecord(
                client,
                buildPendingSiteSubscriptionEntry(session, {
                    planKey,
                    fullName: checkoutInput.fullName,
                    workEmail: checkoutInput.workEmail,
                    companyName: checkoutInput.companyName,
                    sourcePage: checkoutInput.sourcePage || req.get("referer") || ""
                })
            );
        });
        res.status(201).json({
            success: true,
            checkoutUrl: session.url || "",
            sessionId: session.id || ""
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/site/stripe-webhook", express.raw({ type: "application/json" }), async (req, res, next) => {
    try {
        assertDatabaseAvailable();
        const stripe = getStripeClient();
        if (!STRIPE_WEBHOOK_SECRET) {
            throw httpError(503, "Stripe webhook signing secret is not configured yet.");
        }
        const signature = String(req.get("stripe-signature") || "");
        if (!signature) {
            throw httpError(400, "Stripe signature header is required.");
        }

        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
        } catch (error) {
            throw httpError(400, `Stripe webhook verification failed: ${error.message || "signature mismatch"}`);
        }

        const result = await processStripeWebhookEvent(event);
        if (result?.notification) {
            void sendStripeSubscriptionNotification(result.notification).catch((error) => {
                console.error("Failed to send Stripe signup notification:", error.message || error);
            });
        }
        res.json({ received: true, duplicate: result?.duplicate === true });
    } catch (error) {
        next(error);
    }
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

app.get("/api/state", async (req, res, next) => {
    try {
        res.json(await getServerState(pool, { billingEventLimit: 1000, appUser: req.appUser }));
    } catch (error) {
        next(error);
    }
});

app.get("/api/export", async (req, res, next) => {
    try {
        res.json({
            app: "WMS365 Scanner",
            exportedAt: new Date().toISOString(),
            ...(await getServerState(pool, { billingEventLimit: null, appUser: req.appUser }))
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
        assertSuperAdminAccess(req.appUser);
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

app.post("/api/master-partner", async (req, res, next) => {
    try {
        const entry = sanitizeCompanyPartnerInput(req.body);
        if (!entry || !entry.accountName || !entry.partnerType || !entry.name) {
            throw httpError(400, "Company, partner type, and partner name are required.");
        }

        await withTransaction(async (client) => {
            await assertAppUserCompanyAccess(client, req.appUser, entry.accountName);
            await upsertOwnerMaster(client, entry.accountName);
            await upsertCompanyPartner(client, entry);
            await insertActivity(
                client,
                "setup",
                `Saved ${entry.partnerType === "VENDOR" ? "vendor" : "customer"} ${entry.name}`,
                [
                    `Company ${entry.accountName}`,
                    entry.accountCode ? `Code ${entry.accountCode}` : "",
                    entry.contactName ? `Contact ${entry.contactName}` : "",
                    entry.email ? `Email ${entry.email}` : "",
                    entry.note || ""
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
            await assertAppUserCompanyAccess(client, req.appUser, entry.accountName);
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
            await assertAppUserCompanyAccess(client, req.appUser, originalAccountName);
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.BILLING);
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
            await assertAppUserCompanyAccess(client, req.appUser, entry.accountName);
            await assertCompanyFeatureEnabled(client, entry.accountName, COMPANY_FEATURE_KEYS.BILLING);
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.BILLING);
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
            const billingCompanies = await getBillingEventAccountNamesByIds(client, ids);
            for (const accountName of billingCompanies) {
                await assertAppUserCompanyAccess(client, req.appUser, accountName);
                await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.BILLING);
            }
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

app.post("/api/admin/company-features", async (req, res, next) => {
    try {
        assertSuperAdminAccess(req.appUser);
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.vendor || req.body?.customer);
        const featureFlags = sanitizeCompanyFeatureFlagsInput(req.body?.featureFlags || req.body?.feature_flags || req.body?.features || {});
        if (!accountName) {
            throw httpError(400, "Company is required.");
        }

        const owner = await withTransaction(async (client) => {
            await upsertOwnerMaster(client, {
                name: accountName,
                featureFlags,
                featureFlagsUpdatedAt: new Date().toISOString(),
                featureFlagsUpdatedBy: req.appUser?.email || req.appUser?.full_name || "super_admin"
            });
            const savedOwner = await getOwnerAccountRowByName(client, accountName);
            await insertActivity(
                client,
                "setup",
                `Updated feature access for ${accountName}`,
                summarizeEnabledCompanyFeatures(featureFlags)
            );
            return savedOwner;
        });

        res.json({
            success: true,
            owner: owner ? mapOwnerMasterRow(owner) : null,
            featureCatalog: COMPANY_FEATURE_CATALOG
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/app-users", async (req, res, next) => {
    try {
        assertSuperAdminAccess(req.appUser);
        const user = await withTransaction(async (client) => {
            const entry = sanitizeAppUserInput(req.body);
            for (const accountName of entry.assignedCompanies) {
                await upsertOwnerMaster(client, { name: accountName });
            }
            const savedUser = await saveAppUser(client, entry);
            await insertActivity(
                client,
                "setup",
                    `${savedUser.was_created ? "Added" : "Updated"} warehouse user ${savedUser.full_name || savedUser.email}`,
                    [
                        savedUser.email,
                        normalizeText(savedUser.role) === "SUPER_ADMIN"
                            ? "Super user"
                            : `${formatCount((savedUser.assigned_companies || []).length, "company")} assigned`,
                        entry.password ? `Password ${savedUser.was_created ? "created" : "updated"}` : "Profile updated",
                        req.appUser?.email || req.appUser?.full_name || "super_admin"
                    ].filter(Boolean).join(" | ")
            );
            return savedUser;
        });

        res.json({ success: true, user: mapAppUserRow(user) });
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
                await assertAppUserCompanyAccess(client, req.appUser, item.accountName);
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
        assertSuperAdminAccess(req.appUser);
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
                await assertAppUserCompanyAccess(client, req.appUser, rawItem.accountName);
                const master = await findCatalogItem(client, rawItem.accountName, rawItem.sku, rawItem.upc);
                if (master?.lotTracked && !rawItem.lotNumber) {
                    throw httpError(400, `Lot number is required for ${rawItem.accountName} / ${rawItem.sku}.`);
                }
                if (master?.expirationTracked && !rawItem.expirationDate) {
                    throw httpError(400, `Expiration date is required for ${rawItem.accountName} / ${rawItem.sku}.`);
                }
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
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

app.post("/api/inventory/bulk-update", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner);
        const summary = await withTransaction(async (client) => {
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            return saveBulkInventoryWorksheet(client, accountName, req.body?.rows, req.appUser);
        });
        res.json({ success: true, summary });
    } catch (error) {
        next(error);
    }
});

app.post("/api/import", async (req, res, next) => {
    try {
        assertSuperAdminAccess(req.appUser);
        const importedInventory = Array.isArray(req.body?.inventory) ? req.body.inventory.map(sanitizeInventoryLineInput).filter(Boolean) : [];
        const importedActivity = Array.isArray(req.body?.activity) ? req.body.activity.map(sanitizeActivityInput).filter(Boolean) : [];
        const importedPallets = Array.isArray(req.body?.pallets) ? req.body.pallets.map(sanitizePalletRecordInput).filter(Boolean) : [];
        const importedBillingFees = Array.isArray(req.body?.billing?.feeCatalog) ? req.body.billing.feeCatalog.map(sanitizeBillingFeeInput).filter(Boolean) : [];
        const importedOwnerRates = Array.isArray(req.body?.billing?.ownerRates) ? req.body.billing.ownerRates.map(sanitizeOwnerBillingRateInput).filter(Boolean) : [];
        const importedBillingEvents = Array.isArray(req.body?.billing?.events) ? req.body.billing.events.map(sanitizeBillingEventInput).filter(Boolean) : [];
        const importedLocations = Array.isArray(req.body?.masters?.locations) ? req.body.masters.locations.map(sanitizeLocationMasterInput).filter(Boolean) : [];
        const importedItems = Array.isArray(req.body?.masters?.items) ? req.body.masters.items.map(sanitizeItemMasterInput).filter(Boolean) : [];
        const importedPartners = Array.isArray(req.body?.masters?.partners) ? req.body.masters.partners.map(sanitizeCompanyPartnerInput).filter(Boolean) : [];
        const importedOwners = Array.isArray(req.body?.masters?.ownerRecords)
            ? req.body.masters.ownerRecords.map(sanitizeOwnerMasterInput).filter(Boolean)
            : Array.isArray(req.body?.masters?.owners)
                ? req.body.masters.owners.map((owner) => sanitizeOwnerMasterInput(owner)).filter(Boolean)
                : [];

        await withTransaction(async (client) => {
            await client.query("truncate table activity_log, pallet_records, inventory_lines, billing_events, owner_billing_rates, company_partner_accounts, bin_locations, item_catalog, owner_accounts restart identity cascade");

            if (importedBillingFees.length) {
                await client.query("truncate table billing_fee_catalog");
            }

            for (const line of importedInventory) {
                await client.query(
                    `
                        insert into inventory_lines (
                            account_name, location, sku, upc, lot_number, expiration_date, tracking_level, quantity, created_at, updated_at
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    `,
                    [
                        line.accountName,
                        line.location,
                        line.sku,
                        line.upc,
                        line.lotNumber || "",
                        line.expirationDate || "",
                        line.trackingLevel,
                        line.quantity,
                        line.createdAt,
                        line.updatedAt
                    ]
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

            for (const partner of importedPartners) {
                await upsertOwnerMaster(client, partner.accountName);
                await upsertCompanyPartner(client, partner);
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
                            lot_tracked, expiration_tracked,
                            created_at, updated_at
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
                        item.lotTracked === true,
                        item.expirationTracked === true,
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
                `${formatCount(importedInventory.length, "inventory line")} restored, ${formatCount(importedPallets.length, "pallet record")}, ${formatCount(importedBillingEvents.length, "billing line")}, plus ${formatCount(importedOwners.length, "owner")}, ${formatCount(importedPartners.length, "partner")}, ${formatCount(importedLocations.length, "BIN")}, and ${formatCount(importedItems.length, "item master")}.`
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
        await assertAppUserCompanyAccess(pool, req.appUser, pallet.accountName);

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
            await assertAppUserCompanyAccess(client, req.appUser, entry.accountName);
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

app.get("/api/admin/portal-access", async (req, res, next) => {
    try {
        const allowedCompanies = await getAccessibleCompanyNamesForAppUser(pool, req.appUser);
        const access = isSuperAdminUser(req.appUser)
            ? await getPortalAccessList()
            : (await getPortalAccessList()).filter((entry) => allowedCompanies.includes(normalizeText(entry.accountName)));
        res.json({
            access
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/admin/portal-orders", async (req, res, next) => {
    try {
        const requestedAccount = normalizeText(req.query?.accountName || req.query?.account_name || "");
        if (requestedAccount) {
            await assertAppUserCompanyAccess(pool, req.appUser, requestedAccount);
        }
        const orders = requestedAccount
            ? await getPortalOrdersForAccount(requestedAccount)
            : await getAdminPortalOrders();
        res.setHeader("Cache-Control", "no-store");
        const allowedCompanies = await getAccessibleCompanyNamesForAppUser(pool, req.appUser);
        res.json({
            orders: isSuperAdminUser(req.appUser)
                ? orders
                : orders.filter((entry) => allowedCompanies.includes(normalizeText(entry.accountName)))
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/admin/portal-inbounds", async (req, res, next) => {
    try {
        const requestedAccount = normalizeText(req.query?.accountName || req.query?.account_name || "");
        if (requestedAccount) {
            await assertAppUserCompanyAccess(pool, req.appUser, requestedAccount);
        }
        const inbounds = requestedAccount
            ? await getPortalInboundsForAccount(requestedAccount)
            : await getAdminPortalInbounds();
        const allowedCompanies = await getAccessibleCompanyNamesForAppUser(pool, req.appUser);
        res.json({
            inbounds: isSuperAdminUser(req.appUser)
                ? inbounds
                : inbounds.filter((entry) => allowedCompanies.includes(normalizeText(entry.accountName)))
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/admin/feedback", async (req, res, next) => {
    try {
        assertDatabaseAvailable();
        assertSuperAdminAccess(req.appUser);
        res.json({
            feedback: await listFeedbackSubmissions(pool, req.query || {})
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/feedback/:id/status", async (req, res, next) => {
    try {
        assertDatabaseAvailable();
        assertSuperAdminAccess(req.appUser);
        const feedback = await withTransaction((client) => updateFeedbackSubmissionStatus(client, req.params.id, req.body, req.appUser));
        res.json({ success: true, feedback });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/portal-orders", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.company || req.body?.customer);
        if (!accountName) {
            throw httpError(400, "Company is required.");
        }
        const order = await withTransaction(async (client) => {
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
            return saveWarehousePortalOrderDraft(client, accountName, req.body, null, req.appUser);
        });
        res.json({ success: true, order });
    } catch (error) {
        next(error);
    }
});

app.put("/api/admin/portal-orders/:id", async (req, res, next) => {
    try {
        const orderId = toPositiveInt(req.params.id);
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.company || req.body?.customer);
        if (!orderId) {
            throw httpError(400, "A valid order id is required.");
        }
        if (!accountName) {
            throw httpError(400, "Company is required.");
        }
        const order = await withTransaction(async (client) => {
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
            return saveWarehousePortalOrderDraft(client, accountName, req.body, orderId, req.appUser);
        });
        res.json({ success: true, order });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/portal-orders/:id/release", async (req, res, next) => {
    try {
        const orderId = toPositiveInt(req.params.id);
        if (!orderId) {
            throw httpError(400, "A valid order id is required.");
        }
        const order = await withTransaction(async (client) => {
            const accountName = await getPortalOrderAccountNameById(client, orderId);
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
            return releaseWarehousePortalOrder(client, orderId, req.appUser);
        });
        res.json({ success: true, order });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/portal-inbounds", async (req, res, next) => {
    try {
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.company || req.body?.customer);
        if (!accountName) {
            throw httpError(400, "Company is required.");
        }
        const inbound = await withTransaction(async (client) => {
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.INBOUND_NOTICES);
            return saveWarehousePortalInbound(client, accountName, req.body, req.appUser);
        });
        res.status(201).json({ success: true, inbound });
    } catch (error) {
        next(error);
    }
});

app.put("/api/admin/portal-inbounds/:id", async (req, res, next) => {
    try {
        const inboundId = toPositiveInt(req.params.id);
        const accountName = normalizeText(req.body?.accountName || req.body?.owner || req.body?.company || req.body?.customer);
        if (!inboundId) {
            throw httpError(400, "A valid purchase order id is required.");
        }
        if (!accountName) {
            throw httpError(400, "Company is required.");
        }
        const inbound = await withTransaction(async (client) => {
            const currentInbound = await getPortalInboundById(client, inboundId);
            if (!currentInbound) {
                throw httpError(404, "That purchase order could not be found.");
            }
            await assertAppUserCompanyAccess(client, req.appUser, currentInbound.accountName);
            await assertCompanyFeatureEnabled(client, currentInbound.accountName, COMPANY_FEATURE_KEYS.INBOUND_NOTICES);
            return updateWarehousePortalInbound(client, inboundId, accountName, req.body, req.appUser);
        });
        res.json({ success: true, inbound });
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
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            await assertCompanyFeatureEnabled(client, accountName, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
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

app.get("/api/admin/integrations", async (req, res, next) => {
    try {
        const requestedAccount = normalizeText(req.query?.accountName || req.query?.account_name || "");
        if (requestedAccount) {
            await assertAppUserCompanyAccess(pool, req.appUser, requestedAccount);
        }
        const allowedCompanies = await getAccessibleCompanyNamesForAppUser(pool, req.appUser);
        const integrations = await getStoreIntegrationList(pool, requestedAccount);
        res.json({
            integrations: isSuperAdminUser(req.appUser)
                ? integrations
                : integrations.filter((entry) => allowedCompanies.includes(normalizeText(entry.accountName)))
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/integrations", async (req, res, next) => {
    try {
        const savedIntegration = await withTransaction(async (client) => {
            const integration = await saveStoreIntegration(client, req.body);
            await assertAppUserCompanyAccess(client, req.appUser, integration.accountName);
            await assertCompanyFeatureEnabled(client, integration.accountName, COMPANY_FEATURE_KEYS.STORE_INTEGRATIONS);
            if (integration.provider === SHOPIFY_SYNC_PROVIDER) {
                await assertCompanyFeatureEnabled(client, integration.accountName, COMPANY_FEATURE_KEYS.SHOPIFY_INTEGRATION);
            }
            if (integration.provider === SFTP_SYNC_PROVIDER) {
                await assertCompanyFeatureEnabled(client, integration.accountName, COMPANY_FEATURE_KEYS.SFTP_INTEGRATION);
            }
            await upsertOwnerMaster(client, integration.accountName);
            await insertActivity(
                client,
                "setup",
                `${integration.wasCreated ? "Added" : "Updated"} ${integration.provider} integration ${integration.integrationName || integration.storeIdentifier}`,
                [
                    integration.accountName,
                    integration.storeIdentifier || "No store identifier",
                    integration.isActive ? "Connection active." : "Connection disabled.",
                    integration.syncSchedule === "MANUAL"
                        ? "Manual pull only."
                        : `Auto pull ${describeStoreIntegrationSyncSchedule(integration.syncSchedule)}.`,
                    integration.hasAccessToken ? "API token saved." : "No API token saved yet."
                ].filter(Boolean).join(" | ")
            );
            return integration;
        });

        res.json({
            success: true,
            wasCreated: savedIntegration.wasCreated === true,
            integration: savedIntegration
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/integrations/:id/sync", async (req, res, next) => {
    try {
        const integrationId = toPositiveInt(req.params.id);
        if (!integrationId) {
            throw httpError(400, "A valid integration id is required.");
        }

        const integrationRow = await getStoreIntegrationRowById(pool, integrationId);
        if (!integrationRow) {
            throw httpError(404, "That integration could not be found.");
        }
        await assertAppUserCompanyAccess(pool, req.appUser, integrationRow.account_name);
        const result = await syncStoreIntegrationById(integrationId, req.appUser);
        res.json({
            success: true,
            ...result
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
            assertCompanyFeatureEnabledForOwnerRow(vendorAccess, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
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

app.post("/api/portal/feedback", async (req, res, next) => {
    try {
        assertDatabaseAvailable();
        const session = await requirePortalSession(req);
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
        const feedback = await withTransaction((client) => saveFeedbackSubmission(client, req.body, {
            source: "PORTAL",
            accountName: session.access.accountName,
            submittedByEmail: session.access.email || "",
            submittedByName: session.access.accountName || session.access.email || "",
            submittedByRole: "PORTAL_USER",
            buildLabel: req.body?.buildLabel || APP_BUILD_INFO.label || "",
            ipAddress: req.ip || ""
        }));
        res.status(201).json({ success: true, feedback });
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
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

app.get("/api/portal/inventory/export.csv", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
        const inventory = await getPortalInventorySummary(session.access.accountName);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${buildPortalInventoryExportFilename(session.access.accountName)}"`);
        res.send(buildPortalInventoryExportCsv(inventory));
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.INBOUND_NOTICES);
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.INBOUND_NOTICES);
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
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

app.post("/api/portal/items", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
        const item = await withTransaction(async (client) => savePortalCatalogItem(client, session.accessRow, req.body));
        res.status(201).json({ success: true, item });
    } catch (error) {
        if (error.statusCode === 401) {
            clearPortalSessionCookie(res, req);
        }
        next(error);
    }
});

app.put("/api/portal/items/:sku", async (req, res, next) => {
    try {
        const session = await requirePortalSession(req);
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL);
        const originalSku = normalizeText(req.params.sku);
        if (!originalSku) {
            throw httpError(400, "A valid original SKU is required.");
        }
        const item = await withTransaction(async (client) => savePortalCatalogItem(client, session.accessRow, req.body, originalSku));
        res.json({ success: true, item });
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
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
        assertCompanyFeatureEnabledForOwnerRow(session.accessRow, COMPANY_FEATURE_KEYS.ORDER_ENTRY);
        const orderId = toPositiveInt(req.params.id);
        if (!orderId) {
            throw httpError(400, "A valid order id is required.");
        }
        const releaseOptions = sanitizePortalOrderReleaseOptions(req.body);
        let order = await withTransaction(async (client) => releasePortalOrder(client, session.accessRow, orderId));
        let releasePdf = null;
        const releaseActions = {
            warehouseEmailRequested: releaseOptions.notifyWarehouse,
            warehouseEmailSent: false,
            warehouseRecipients: [],
            ccRecipients: [...releaseOptions.ccEmails],
            warehouseEmailError: "",
            pdfCopyRequested: releaseOptions.savePdfCopy,
            pdfSaved: false,
            pdfAlreadySaved: false,
            pdfFileName: "",
            pdfSaveError: ""
        };

        if (releaseOptions.savePdfCopy) {
            try {
                releasePdf = buildPortalOrderReleasePdf(order);
                releaseActions.pdfFileName = releasePdf.fileName;
            } catch (error) {
                const message = error?.message || "Could not create the order PDF copy.";
                if (releaseOptions.savePdfCopy) {
                    releaseActions.pdfSaveError = message;
                }
                releasePdf = null;
            }
        }

        if (releaseOptions.savePdfCopy && releasePdf) {
            try {
                const saveResult = await withTransaction(async (client) => savePortalReleasePdfCopy(
                    client,
                    order,
                    releasePdf,
                    session.access.email || "Company portal",
                    {
                        downloadPathPrefix: "/api/portal/order-documents",
                        activityActor: session.access.email || "Company portal"
                    }
                ));
                order = saveResult.order || order;
                releaseActions.pdfSaved = saveResult.alreadySaved !== true;
                releaseActions.pdfAlreadySaved = saveResult.alreadySaved === true;
                if (saveResult.document?.fileName) {
                    releaseActions.pdfFileName = saveResult.document.fileName;
                }
            } catch (error) {
                releaseActions.pdfSaveError = error?.message || "The PDF copy could not be saved.";
            }
        }

        if (releaseOptions.notifyWarehouse) {
            try {
                const emailResult = await sendPortalOrderReleaseEmail(order, {
                    ccRecipients: releaseOptions.ccEmails,
                    pdfDocument: releasePdf
                });
                releaseActions.warehouseEmailSent = true;
                releaseActions.warehouseRecipients = emailResult.recipients;
                releaseActions.ccRecipients = emailResult.ccRecipients;

                await withTransaction(async (client) => {
                    await insertActivity(
                        client,
                        "order",
                        `Emailed warehouse release ${order.orderCode}`,
                        [
                            order.accountName,
                            emailResult.recipients.join(", "),
                            emailResult.ccRecipients.length ? `CC ${emailResult.ccRecipients.join(", ")}` : "",
                            session.access.email || "Company portal"
                        ].filter(Boolean).join(" | ")
                    );
                });
            } catch (error) {
                releaseActions.warehouseEmailError = error?.message || "The warehouse email could not be sent.";
            }
        }

        res.json({ success: true, order, releaseActions });
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
            const accountName = await getPortalOrderAccountNameById(client, orderId);
            await assertAppUserCompanyAccess(client, req.appUser, accountName);
            return updateAdminPortalOrderStatus(client, orderId, nextStatus, req.body, req.appUser);
        });

        res.json({ success: true, order });
    } catch (error) {
        next(error);
    }
});

app.post("/api/admin/portal-inbounds/:id/status", async (req, res, next) => {
    try {
        const inboundId = toPositiveInt(req.params.id);
        const nextStatus = normalizePortalInboundStatus(req.body?.status);
        if (!inboundId) {
            throw httpError(400, "A valid purchase order id is required.");
        }
        if (!nextStatus) {
            throw httpError(400, "A valid purchase order status is required.");
        }

        const inbound = await withTransaction(async (client) => {
            const currentInbound = await getPortalInboundById(client, inboundId);
            if (!currentInbound) {
                throw httpError(404, "That purchase order could not be found.");
            }
            await assertAppUserCompanyAccess(client, req.appUser, currentInbound.accountName);
            return updateAdminPortalInboundStatus(client, inboundId, nextStatus, req.appUser);
        });

        res.json({ success: true, inbound });
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
        await assertAppUserCompanyAccess(pool, req.appUser, document.account_name);

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
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(ROOT_DIR, "portal.html"));
});

app.get("/portal.html", (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(ROOT_DIR, "portal.html"));
});

app.get("/mobile-pick", async (req, res) => {
    try {
        await requireAppSession(req);
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.sendFile(path.join(ROOT_DIR, "mobile-pick.html"));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/mobile-pick"));
    }
});

app.get("/mobile-pick.html", async (req, res) => {
    try {
        await requireAppSession(req);
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.sendFile(path.join(ROOT_DIR, "mobile-pick.html"));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/mobile-pick"));
    }
});

app.get("/login", (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(ROOT_DIR, "login.html"));
});

app.get("/login.html", (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(ROOT_DIR, "login.html"));
});

function detectWarehouseRouteMode(req) {
    const requestedMode = String(req.query?.experience || req.query?.mode || "").trim().toLowerCase();
    if (requestedMode === "mobile" || requestedMode === "desktop") {
        return requestedMode;
    }
    const userAgent = String(req.headers["user-agent"] || "");
    return /iphone|ipod|android.+mobile|windows phone|blackberry|opera mini|mobile/i.test(userAgent)
        ? "mobile"
        : "desktop";
}

function getWarehouseRoutePath(req) {
    return detectWarehouseRouteMode(req) === "mobile" ? "/mobile" : "/desktop";
}

function sanitizeInternalAppPath(value, fallbackPath = "/app") {
    const text = String(value || "").trim();
    if (!text || !text.startsWith("/") || text.startsWith("//")) return fallbackPath;
    if (text === "/login" || text === "/login.html") return fallbackPath;
    return text;
}

function buildWarehouseLoginRedirect(req, fallbackPath = "/app") {
    const nextPath = sanitizeInternalAppPath(req.originalUrl || fallbackPath, fallbackPath);
    return `/login?next=${encodeURIComponent(nextPath)}`;
}

async function getAppDomainHomePath(req, res) {
    try {
        await requireAppSession(req);
        return "/app";
    } catch (_error) {
        clearAppSessionCookie(res, req);
    }
    try {
        await requirePortalSession(req);
        return "/portal";
    } catch (_error) {
        clearPortalSessionCookie(res, req);
    }
    return "/login";
}

function sendWarehouseApp(res) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(ROOT_DIR, "index.html"));
}

function isPublicSiteRequest(req) {
    const publicOrigin = normalizeOriginUrl(PUBLIC_SITE_URL);
    if (!publicOrigin) return true;
    return normalizeOriginUrl(getRequestOrigin(req)) === publicOrigin;
}

function sendMarketingPage(req, res, fileName) {
    if (!isPublicSiteRequest(req)) {
        const publicOrigin = normalizeOriginUrl(PUBLIC_SITE_URL);
        if (publicOrigin) {
            return res.redirect(`${publicOrigin}${req.path === "/" ? "" : req.path}`);
        }
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    res.sendFile(path.join(ROOT_DIR, fileName));
}

function sendMarketingAsset(res, fileName, contentType) {
    if (contentType) {
        res.type(contentType);
    }
    res.sendFile(path.join(ROOT_DIR, fileName));
}

app.get("/", async (req, res) => {
    if (!isPublicSiteRequest(req)) {
        return res.redirect(await getAppDomainHomePath(req, res));
    }
    sendMarketingPage(req, res, "site.html");
});

app.get("/index.html", async (req, res) => {
    if (!isPublicSiteRequest(req)) {
        return res.redirect(await getAppDomainHomePath(req, res));
    }
    sendMarketingPage(req, res, "site.html");
});

app.get("/marketing", (req, res) => {
    sendMarketingPage(req, res, "site.html");
});

app.get("/marketing.html", (req, res) => {
    sendMarketingPage(req, res, "site.html");
});

app.get("/pricing", (req, res) => {
    sendMarketingPage(req, res, "pricing.html");
});

app.get("/pricing.html", (req, res) => {
    sendMarketingPage(req, res, "pricing.html");
});

app.get("/industries", (req, res) => {
    sendMarketingPage(req, res, "industries.html");
});

app.get("/industries.html", (req, res) => {
    sendMarketingPage(req, res, "industries.html");
});

app.get("/book-demo", (req, res) => {
    sendMarketingPage(req, res, "book-demo.html");
});

app.get("/book-demo.html", (req, res) => {
    sendMarketingPage(req, res, "book-demo.html");
});

app.get("/integrations", (req, res) => {
    sendMarketingPage(req, res, "integrations.html");
});

app.get("/integrations.html", (req, res) => {
    sendMarketingPage(req, res, "integrations.html");
});

app.get("/implementation", (req, res) => {
    sendMarketingPage(req, res, "implementation.html");
});

app.get("/implementation.html", (req, res) => {
    sendMarketingPage(req, res, "implementation.html");
});

app.get("/3pl-warehouse-management-software", (req, res) => {
    sendMarketingPage(req, res, "3pl-warehouse-management-software.html");
});

app.get("/3pl-warehouse-management-software.html", (req, res) => {
    sendMarketingPage(req, res, "3pl-warehouse-management-software.html");
});

app.get("/shopify-warehouse-management-software", (req, res) => {
    sendMarketingPage(req, res, "shopify-warehouse-management-software.html");
});

app.get("/shopify-warehouse-management-software.html", (req, res) => {
    sendMarketingPage(req, res, "shopify-warehouse-management-software.html");
});

app.get("/lot-tracking-expiration-date-inventory-software", (req, res) => {
    sendMarketingPage(req, res, "lot-tracking-expiration-date-inventory-software.html");
});

app.get("/lot-tracking-expiration-date-inventory-software.html", (req, res) => {
    sendMarketingPage(req, res, "lot-tracking-expiration-date-inventory-software.html");
});

app.get("/customer-portal-for-3pl-warehouses", (req, res) => {
    sendMarketingPage(req, res, "customer-portal-for-3pl-warehouses.html");
});

app.get("/customer-portal-for-3pl-warehouses.html", (req, res) => {
    sendMarketingPage(req, res, "customer-portal-for-3pl-warehouses.html");
});

app.get("/sftp-warehouse-integration-software", (req, res) => {
    sendMarketingPage(req, res, "sftp-warehouse-integration-software.html");
});

app.get("/sftp-warehouse-integration-software.html", (req, res) => {
    sendMarketingPage(req, res, "sftp-warehouse-integration-software.html");
});

app.get("/robots.txt", (req, res) => {
    res.type("text/plain; charset=utf-8");
    if (!isPublicSiteRequest(req)) {
        return res.send("User-agent: *\nDisallow: /\n");
    }
    return res.sendFile(path.join(ROOT_DIR, "robots.txt"));
});

app.get("/sitemap.xml", (_req, res) => {
    res.type("application/xml; charset=utf-8");
    res.sendFile(path.join(ROOT_DIR, "sitemap.xml"));
});

app.get("/marketing.css", (_req, res) => {
    sendMarketingAsset(res, "marketing.css", "text/css; charset=utf-8");
});

app.get("/marketing.js", (_req, res) => {
    sendMarketingAsset(res, "marketing.js", "application/javascript; charset=utf-8");
});

app.get("/marketing-logo.svg", (_req, res) => {
    sendMarketingAsset(res, "marketing-logo.svg", "image/svg+xml; charset=utf-8");
});

app.get("/site.webmanifest", (_req, res) => {
    sendMarketingAsset(res, "site.webmanifest", "application/manifest+json; charset=utf-8");
});

app.get("/hero-warehouse-scene.svg", (_req, res) => {
    sendMarketingAsset(res, "hero-warehouse-scene.svg", "image/svg+xml; charset=utf-8");
});

app.get("/industry-3pl-scene.svg", (_req, res) => {
    sendMarketingAsset(res, "industry-3pl-scene.svg", "image/svg+xml; charset=utf-8");
});

app.get("/industry-ecommerce-scene.svg", (_req, res) => {
    sendMarketingAsset(res, "industry-ecommerce-scene.svg", "image/svg+xml; charset=utf-8");
});

app.get("/industry-lot-control-scene.svg", (_req, res) => {
    sendMarketingAsset(res, "industry-lot-control-scene.svg", "image/svg+xml; charset=utf-8");
});

app.get("/app", async (req, res) => {
    try {
        await requireAppSession(req);
        res.redirect(getWarehouseRoutePath(req));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/app"));
    }
});

app.get("/app/", async (req, res) => {
    try {
        await requireAppSession(req);
        res.redirect(getWarehouseRoutePath(req));
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/app"));
    }
});

app.get("/desktop", async (req, res) => {
    try {
        await requireAppSession(req);
        sendWarehouseApp(res);
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/desktop"));
    }
});

app.get("/desktop/", async (req, res) => {
    try {
        await requireAppSession(req);
        sendWarehouseApp(res);
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/desktop"));
    }
});

app.get("/inventory-worksheet", async (req, res) => {
    try {
        await requireAppSession(req);
        res.redirect("/desktop?section=inventory&target=inventory-worksheet");
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/inventory-worksheet"));
    }
});

app.get("/inventory-worksheet/", async (req, res) => {
    try {
        await requireAppSession(req);
        res.redirect("/desktop?section=inventory&target=inventory-worksheet");
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/inventory-worksheet"));
    }
});

app.get("/mobile", async (req, res) => {
    try {
        await requireAppSession(req);
        sendWarehouseApp(res);
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/mobile"));
    }
});

app.get("/mobile/", async (req, res) => {
    try {
        await requireAppSession(req);
        sendWarehouseApp(res);
    } catch (_error) {
        clearAppSessionCookie(res, req);
        res.redirect(buildWarehouseLoginRedirect(req, "/mobile"));
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
            lot_number text not null default '',
            expiration_date text not null default '',
            quantity integer not null check (quantity > 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);
    await pool.query(`alter table inventory_lines add column if not exists account_name text not null default '${LEGACY_ACCOUNT}';`);
    await pool.query("alter table inventory_lines add column if not exists tracking_level text not null default 'UNIT';");
    await pool.query("alter table inventory_lines add column if not exists lot_number text not null default '';");
    await pool.query("alter table inventory_lines add column if not exists expiration_date text not null default '';");
    await pool.query("update inventory_lines set account_name = $1 where account_name is null or account_name = ''", [LEGACY_ACCOUNT]);
    await pool.query("update inventory_lines set tracking_level = 'UNIT' where tracking_level is null or tracking_level = ''");
    await pool.query("update inventory_lines set lot_number = '' where lot_number is null");
    await pool.query("update inventory_lines set expiration_date = '' where expiration_date is null");
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
    await pool.query("alter table owner_accounts add column if not exists feature_flags jsonb;");
    await pool.query("alter table owner_accounts add column if not exists feature_flags_updated_at timestamptz;");
    await pool.query("alter table owner_accounts add column if not exists feature_flags_updated_by text not null default '';");

    await pool.query(`
        create table if not exists company_partner_accounts (
            id bigserial primary key,
            account_name text not null,
            partner_type text not null,
            name text not null,
            account_code text not null default '',
            contact_name text not null default '',
            contact_title text not null default '',
            email text not null default '',
            phone text not null default '',
            mobile text not null default '',
            website text not null default '',
            address1 text not null default '',
            address2 text not null default '',
            city text not null default '',
            state text not null default '',
            postal_code text not null default '',
            country text not null default '',
            is_active boolean not null default true,
            note text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);
    await pool.query("create unique index if not exists idx_company_partner_accounts_unique on company_partner_accounts (account_name, partner_type, name);");
    await pool.query("create index if not exists idx_company_partner_accounts_company on company_partner_accounts (account_name);");
    await pool.query("create index if not exists idx_company_partner_accounts_type on company_partner_accounts (partner_type);");

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

    await pool.query(`
        create table if not exists app_user_company_access (
            id bigserial primary key,
            app_user_id bigint not null references app_users(id) on delete cascade,
            account_name text not null,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (app_user_id, account_name)
        );
    `);

    await pool.query("update app_users set email = lower(email) where email is not null and email <> lower(email)");
    await pool.query("create index if not exists idx_app_user_company_access_user on app_user_company_access (app_user_id)");
    await pool.query("create index if not exists idx_app_user_company_access_account on app_user_company_access (account_name)");
    await ensureDefaultAppAdmin();

    await pool.query(`
        create table if not exists site_demo_requests (
            id bigserial primary key,
            full_name text not null default '',
            work_email text not null default '',
            company_name text not null default '',
            phone text not null default '',
            role_title text not null default '',
            warehouse_count text not null default '',
            monthly_order_volume text not null default '',
            operations_type text not null default '',
            interest_summary text not null default '',
            message text not null default '',
            source_page text not null default '',
            browser_locale text not null default '',
            ip_address text not null default '',
            user_agent text not null default '',
            created_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists site_subscriptions (
            id bigserial primary key,
            checkout_session_id text not null default '',
            stripe_customer_id text not null default '',
            stripe_subscription_id text not null default '',
            stripe_price_id text not null default '',
            stripe_product_id text not null default '',
            latest_invoice_id text not null default '',
            plan_key text not null default '',
            plan_label text not null default '',
            company_name text not null default '',
            company_account_name text not null default '',
            full_name text not null default '',
            work_email text not null default '',
            source_page text not null default '',
            status text not null default 'PENDING',
            billing_status text not null default 'PENDING',
            checkout_status text not null default '',
            payment_status text not null default '',
            provisioning_status text not null default 'PENDING_REVIEW',
            metadata jsonb not null default '{}'::jsonb,
            last_event_id text not null default '',
            last_event_type text not null default '',
            current_period_start timestamptz,
            current_period_end timestamptz,
            trial_started_at timestamptz,
            trial_ends_at timestamptz,
            cancel_at timestamptz,
            canceled_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists stripe_webhook_events (
            event_id text primary key,
            event_type text not null default '',
            processed_at timestamptz not null default now()
        );
    `);

    await pool.query(`
        create table if not exists scheduled_job_runs (
            id bigserial primary key,
            job_key text not null,
            run_key text not null,
            status text not null default 'RUNNING',
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            error_message text not null default '',
            metadata jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (job_key, run_key)
        );
    `);
    await pool.query("alter table scheduled_job_runs add column if not exists status text not null default 'RUNNING'");
    await pool.query("alter table scheduled_job_runs add column if not exists started_at timestamptz not null default now()");
    await pool.query("alter table scheduled_job_runs add column if not exists finished_at timestamptz");
    await pool.query("alter table scheduled_job_runs add column if not exists error_message text not null default ''");
    await pool.query("alter table scheduled_job_runs add column if not exists metadata jsonb not null default '{}'::jsonb");
    await pool.query("alter table scheduled_job_runs add column if not exists created_at timestamptz not null default now()");
    await pool.query("alter table scheduled_job_runs add column if not exists updated_at timestamptz not null default now()");
    await pool.query("update scheduled_job_runs set metadata = '{}'::jsonb where metadata is null");
    await pool.query("alter table scheduled_job_runs drop constraint if exists scheduled_job_runs_status_check");
    await pool.query("alter table scheduled_job_runs add constraint scheduled_job_runs_status_check check (status in ('RUNNING', 'SENT', 'FAILED'))");
    await pool.query("create index if not exists idx_scheduled_job_runs_job_started_at on scheduled_job_runs (job_key, started_at desc)");

    await pool.query(`
        create table if not exists feedback_submissions (
            id bigserial primary key,
            request_type text not null default 'BUG',
            source text not null default 'WAREHOUSE',
            account_name text not null default '',
            submitted_by_email text not null default '',
            submitted_by_name text not null default '',
            submitted_by_role text not null default '',
            title text not null default '',
            details text not null default '',
            page_name text not null default '',
            app_section text not null default '',
            page_url text not null default '',
            build_label text not null default '',
            browser_info text not null default '',
            ip_address text not null default '',
            status text not null default 'NEW',
            admin_note text not null default '',
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
    await pool.query("alter table item_catalog add column if not exists lot_tracked boolean not null default false;");
    await pool.query("alter table item_catalog add column if not exists expiration_tracked boolean not null default false;");
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
            received_at timestamptz,
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
    await pool.query("alter table portal_inbounds add column if not exists received_at timestamptz");

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
        create table if not exists portal_order_allocations (
            id bigserial primary key,
            order_id bigint not null references portal_orders(id) on delete cascade,
            order_line_id bigint not null references portal_order_lines(id) on delete cascade,
            inventory_line_id bigint references inventory_lines(id) on delete set null,
            sku text not null,
            location text not null default '',
            lot_number text not null default '',
            expiration_date text not null default '',
            tracking_level text not null default 'UNIT',
            allocated_quantity integer not null check (allocated_quantity > 0),
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
    await pool.query(`
        create table if not exists store_integrations (
            id bigserial primary key,
            account_name text not null,
            provider text not null,
            integration_name text not null default '',
            store_identifier text not null default '',
            access_token text not null default '',
            auth_client_id text not null default '',
            auth_client_secret text not null default '',
            access_token_expires_at timestamptz,
            settings jsonb not null default '{}'::jsonb,
            import_status text not null default 'DRAFT',
            is_active boolean not null default true,
            sync_schedule text not null default 'MANUAL',
            next_scheduled_sync_at timestamptz,
            last_synced_at timestamptz,
            last_sync_status text not null default 'IDLE',
            last_sync_message text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint store_integrations_provider_check check (provider in ('SHOPIFY', 'SFTP', 'WOOCOMMERCE', 'BIGCOMMERCE', 'AMAZON', 'ETSY', 'CUSTOM_API')),
            constraint store_integrations_import_status_check check (import_status in ('DRAFT', 'RELEASED')),
            constraint store_integrations_sync_status_check check (last_sync_status in ('IDLE', 'SUCCESS', 'WARNING', 'ERROR')),
            constraint store_integrations_sync_schedule_check check (sync_schedule in ('MANUAL', 'EVERY_5_MINUTES', 'EVERY_15_MINUTES', 'EVERY_30_MINUTES', 'HOURLY', 'DAILY_0900', 'DAILY_1200', 'DAILY_1500', 'DAILY_1800'))
        );
    `);
    await pool.query("alter table store_integrations add column if not exists integration_name text not null default ''");
    await pool.query("alter table store_integrations add column if not exists store_identifier text not null default ''");
    await pool.query("alter table store_integrations add column if not exists access_token text not null default ''");
    await pool.query("alter table store_integrations add column if not exists auth_client_id text not null default ''");
    await pool.query("alter table store_integrations add column if not exists auth_client_secret text not null default ''");
    await pool.query("alter table store_integrations add column if not exists access_token_expires_at timestamptz");
    await pool.query("alter table store_integrations add column if not exists settings jsonb not null default '{}'::jsonb");
    await pool.query("alter table store_integrations add column if not exists import_status text not null default 'DRAFT'");
    await pool.query("alter table store_integrations add column if not exists is_active boolean not null default true");
    await pool.query("alter table store_integrations add column if not exists sync_schedule text not null default 'MANUAL'");
    await pool.query("alter table store_integrations add column if not exists next_scheduled_sync_at timestamptz");
    await pool.query("alter table store_integrations add column if not exists last_synced_at timestamptz");
    await pool.query("alter table store_integrations add column if not exists last_sync_status text not null default 'IDLE'");
    await pool.query("alter table store_integrations add column if not exists last_sync_message text not null default ''");
    await pool.query("alter table store_integrations drop constraint if exists store_integrations_provider_check");
    await pool.query("alter table store_integrations add constraint store_integrations_provider_check check (provider in ('SHOPIFY', 'SFTP', 'WOOCOMMERCE', 'BIGCOMMERCE', 'AMAZON', 'ETSY', 'CUSTOM_API'))");
    await pool.query("alter table store_integrations drop constraint if exists store_integrations_import_status_check");
    await pool.query("alter table store_integrations add constraint store_integrations_import_status_check check (import_status in ('DRAFT', 'RELEASED'))");
    await pool.query("alter table store_integrations drop constraint if exists store_integrations_sync_status_check");
    await pool.query("alter table store_integrations add constraint store_integrations_sync_status_check check (last_sync_status in ('IDLE', 'SUCCESS', 'WARNING', 'ERROR'))");
    await pool.query("alter table store_integrations drop constraint if exists store_integrations_sync_schedule_check");
    await pool.query("alter table store_integrations add constraint store_integrations_sync_schedule_check check (sync_schedule in ('MANUAL', 'EVERY_5_MINUTES', 'EVERY_15_MINUTES', 'EVERY_30_MINUTES', 'HOURLY', 'DAILY_0900', 'DAILY_1200', 'DAILY_1500', 'DAILY_1800'))");
    await pool.query("update store_integrations set next_scheduled_sync_at = null where is_active = false or sync_schedule = 'MANUAL'");
    await pool.query("update store_integrations set next_scheduled_sync_at = now() where is_active = true and sync_schedule <> 'MANUAL' and next_scheduled_sync_at is null");
    await pool.query(`
        create table if not exists store_order_imports (
            id bigserial primary key,
            integration_id bigint not null references store_integrations(id) on delete cascade,
            external_order_id text not null,
            portal_order_id bigint not null references portal_orders(id) on delete cascade,
            imported_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            unique (integration_id, external_order_id),
            unique (portal_order_id)
        );
    `);
    await pool.query(`
        create table if not exists store_inbound_imports (
            id bigserial primary key,
            integration_id bigint not null references store_integrations(id) on delete cascade,
            external_inbound_id text not null,
            portal_inbound_id bigint not null references portal_inbounds(id) on delete cascade,
            imported_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            unique (integration_id, external_inbound_id),
            unique (portal_inbound_id)
        );
    `);
    await pool.query(`
        create table if not exists store_sync_exports (
            id bigserial primary key,
            integration_id bigint not null references store_integrations(id) on delete cascade,
            entity_type text not null,
            entity_ref text not null default '',
            content_hash text not null,
            remote_path text not null default '',
            created_at timestamptz not null default now(),
            unique (integration_id, entity_type, entity_ref, content_hash)
        );
    `);
    await pool.query("update portal_orders set order_code = null where order_code = ''");
    await pool.query("update portal_orders set order_code = concat('ORD-', lpad(id::text, 6, '0')) where order_code is null");
    await pool.query("delete from portal_sessions where expires_at <= now()");

    await pool.query("drop index if exists idx_inventory_lines_account_location_sku_unique;");
    await pool.query("create index if not exists idx_inventory_lines_account_location_sku on inventory_lines (account_name, location, sku);");
    await pool.query("create unique index if not exists idx_inventory_lines_identity_unique on inventory_lines (account_name, location, sku, lot_number, expiration_date);");
    await pool.query("create unique index if not exists idx_item_catalog_account_sku_unique on item_catalog (account_name, sku);");
    await pool.query("create unique index if not exists idx_pallet_records_code_unique on pallet_records (pallet_code);");
    await pool.query("create index if not exists idx_pallet_records_account_name on pallet_records (account_name);");
    await pool.query("create index if not exists idx_pallet_records_location on pallet_records (location);");
    await pool.query("create index if not exists idx_pallet_records_sku on pallet_records (sku);");
    await pool.query("create index if not exists idx_site_demo_requests_created_at on site_demo_requests (created_at desc);");
    await pool.query("create index if not exists idx_site_demo_requests_work_email on site_demo_requests (work_email);");
    await pool.query("create unique index if not exists idx_site_subscriptions_checkout_session_unique on site_subscriptions (checkout_session_id) where checkout_session_id <> '';");
    await pool.query("create unique index if not exists idx_site_subscriptions_subscription_unique on site_subscriptions (stripe_subscription_id) where stripe_subscription_id <> '';");
    await pool.query("create index if not exists idx_site_subscriptions_created_at on site_subscriptions (created_at desc);");
    await pool.query("create index if not exists idx_site_subscriptions_work_email on site_subscriptions (work_email);");
    await pool.query("create index if not exists idx_site_subscriptions_company_account_name on site_subscriptions (company_account_name);");
    await pool.query("create index if not exists idx_feedback_submissions_created_at on feedback_submissions (created_at desc);");
    await pool.query("create index if not exists idx_feedback_submissions_status on feedback_submissions (status);");
    await pool.query("create index if not exists idx_feedback_submissions_account_name on feedback_submissions (account_name);");
    await pool.query("create index if not exists idx_feedback_submissions_source on feedback_submissions (source);");
    await pool.query("create index if not exists idx_feedback_submissions_request_type on feedback_submissions (request_type);");
    await pool.query("create index if not exists idx_inventory_lines_account_name on inventory_lines (account_name);");
    await pool.query("create index if not exists idx_inventory_lines_location on inventory_lines (location);");
    await pool.query("create index if not exists idx_inventory_lines_sku on inventory_lines (sku);");
    await pool.query("create index if not exists idx_inventory_lines_lot_number on inventory_lines (lot_number);");
    await pool.query("create index if not exists idx_inventory_lines_expiration_date on inventory_lines (expiration_date);");
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
    await pool.query("create index if not exists idx_portal_order_allocations_order_id on portal_order_allocations (order_id);");
    await pool.query("create index if not exists idx_portal_order_allocations_order_line_id on portal_order_allocations (order_line_id);");
    await pool.query("create index if not exists idx_portal_order_allocations_inventory_line_id on portal_order_allocations (inventory_line_id);");
    await pool.query("create index if not exists idx_portal_order_allocations_sku on portal_order_allocations (sku);");
    await pool.query("create index if not exists idx_portal_order_documents_order_id on portal_order_documents (order_id);");
    await pool.query("create unique index if not exists idx_portal_inbounds_inbound_code_unique on portal_inbounds (inbound_code);");
    await pool.query("create index if not exists idx_portal_inbounds_account_name on portal_inbounds (account_name);");
    await pool.query("create index if not exists idx_portal_inbounds_status on portal_inbounds (status);");
    await pool.query("create index if not exists idx_portal_inbound_lines_inbound_id on portal_inbound_lines (inbound_id);");
    await pool.query("create unique index if not exists idx_store_integrations_account_provider_store_unique on store_integrations (account_name, provider, store_identifier);");
    await pool.query("create index if not exists idx_store_integrations_account_name on store_integrations (account_name);");
    await pool.query("create index if not exists idx_store_integrations_provider on store_integrations (provider);");
    await pool.query("create index if not exists idx_store_integrations_next_scheduled_sync_at on store_integrations (next_scheduled_sync_at);");
    await pool.query("create index if not exists idx_store_order_imports_integration_id on store_order_imports (integration_id);");
    await pool.query("create index if not exists idx_store_order_imports_external_order_id on store_order_imports (external_order_id);");
    await pool.query("create index if not exists idx_store_inbound_imports_integration_id on store_inbound_imports (integration_id);");
    await pool.query("create index if not exists idx_store_inbound_imports_external_inbound_id on store_inbound_imports (external_inbound_id);");
    await pool.query("create index if not exists idx_store_sync_exports_integration_id on store_sync_exports (integration_id);");
    await pool.query("create index if not exists idx_store_sync_exports_entity_type on store_sync_exports (entity_type);");
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
            ensureStoreIntegrationSchedulerStarted();
            ensureAdminActivityDigestSchedulerStarted();
            console.log("PostgreSQL schema ready.");
        } catch (error) {
            databaseReady = false;
            databaseErrorMessage = error.message;
            console.error("Database initialization failed. Retrying in 5 seconds.", error);
            await delay(5000);
        }
    }
}

async function getServerState(client = pool, { billingEventLimit = 1000, appUser = null } = {}) {
    const billingEventsQuery = Number.isFinite(billingEventLimit) && billingEventLimit > 0
        ? client.query("select * from billing_events order by service_date desc, id desc limit $1", [billingEventLimit])
        : client.query("select * from billing_events order by service_date desc, id desc");

    const [inventoryResult, activityResult, locationResult, ownerResult, partnerResult, itemResult, palletResult, billingFeeResult, ownerRateResult, billingEventResult, metaResult] = await Promise.all([
        client.query("select * from inventory_lines order by account_name asc, location asc, sku asc"),
        client.query("select * from activity_log order by created_at desc limit $1", [80]),
        client.query("select * from bin_locations order by code asc"),
        client.query("select * from owner_accounts order by name asc"),
        client.query("select * from company_partner_accounts order by account_name asc, partner_type asc, name asc"),
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
                    coalesce((select max(updated_at) from company_partner_accounts), to_timestamp(0)),
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

    const accessibleCompanies = appUser && !isSuperAdminUser(appUser)
        ? await getAccessibleCompanyNamesForAppUser(client, appUser)
        : [];
    const companyScoped = appUser && !isSuperAdminUser(appUser);

    const inventoryRows = companyScoped
        ? filterRowsByAllowedCompanies(inventoryResult.rows, accessibleCompanies, (row) => row.account_name)
        : inventoryResult.rows;
    const palletRows = companyScoped
        ? filterRowsByAllowedCompanies(palletResult.rows, accessibleCompanies, (row) => row.account_name)
        : palletResult.rows;
    const ownerRows = companyScoped
        ? filterRowsByAllowedCompanies(ownerResult.rows, accessibleCompanies, (row) => row.name)
        : ownerResult.rows;
    const partnerRows = companyScoped
        ? filterRowsByAllowedCompanies(partnerResult.rows, accessibleCompanies, (row) => row.account_name)
        : partnerResult.rows;
    const itemRows = companyScoped
        ? filterRowsByAllowedCompanies(itemResult.rows, accessibleCompanies, (row) => row.account_name)
        : itemResult.rows;
    const ownerRateRows = companyScoped
        ? filterRowsByAllowedCompanies(ownerRateResult.rows, accessibleCompanies, (row) => row.account_name)
        : ownerRateResult.rows;
    const billingEventRows = companyScoped
        ? filterRowsByAllowedCompanies(billingEventResult.rows, accessibleCompanies, (row) => row.account_name)
        : billingEventResult.rows;
    const activityRows = companyScoped ? [] : activityResult.rows;
    const appUsers = isSuperAdminUser(appUser) ? await getAppUsersWithAssignments(client) : [];

    const owners = [...new Set(
        ownerRows.map((row) => row.name)
            .concat(inventoryRows.map((row) => row.account_name))
            .concat(itemRows.map((row) => row.account_name))
    )].filter(Boolean).sort();

    return {
        inventory: inventoryRows.map(mapInventoryRow),
        pallets: palletRows.map(mapPalletRecordRow),
        activity: activityRows.map(mapActivityRow),
        masters: {
            locations: locationResult.rows.map(mapLocationMasterRow),
            ownerRecords: ownerRows.map(mapOwnerMasterRow),
            partners: partnerRows.map(mapCompanyPartnerRow),
            items: itemRows.map(mapItemMasterRow),
            owners
        },
        billing: {
            feeCatalog: billingFeeResult.rows.map(mapBillingFeeRow),
            ownerRates: ownerRateRows.map(mapOwnerBillingRateRow),
            events: billingEventRows.map(mapBillingEventRow)
        },
        session: {
            appUser: appUser ? mapAppUserRow(appUser) : null
        },
        admin: {
            appUsers: appUsers.map(mapAppUserRow)
        },
        featureCatalog: COMPANY_FEATURE_CATALOG,
        meta: {
            version: 8,
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

async function getAppUserCompanyAssignments(client, userId) {
    const normalizedUserId = Number(userId) || 0;
    if (normalizedUserId <= 0) return [];
    const result = await client.query(
        `
            select account_name
            from app_user_company_access
            where app_user_id = $1
            order by account_name asc
        `,
        [normalizedUserId]
    );
    return result.rows.map((row) => normalizeText(row.account_name)).filter(Boolean);
}

async function attachAppUserCompanyAssignments(client, userRow) {
    if (!userRow) return null;
    const assignedCompanies = await getAppUserCompanyAssignments(client, userRow.id || userRow.app_user_id);
    return {
        ...userRow,
        assigned_companies: assignedCompanies
    };
}

async function getAppUsersWithAssignments(client = pool) {
    const [userResult, accessResult] = await Promise.all([
        client.query("select * from app_users order by role asc, full_name asc, email asc, id asc"),
        client.query("select * from app_user_company_access order by account_name asc, id asc")
    ]);

    const assignmentsByUserId = new Map();
    accessResult.rows.forEach((row) => {
        const key = String(row.app_user_id);
        if (!assignmentsByUserId.has(key)) assignmentsByUserId.set(key, []);
        const normalizedAccount = normalizeText(row.account_name);
        if (normalizedAccount) assignmentsByUserId.get(key).push(normalizedAccount);
    });

    return userResult.rows.map((row) => ({
        ...row,
        assigned_companies: [...new Set(assignmentsByUserId.get(String(row.id)) || [])]
    }));
}

function normalizeAppUserRole(value) {
    return normalizeText(value) === "SUPER_ADMIN" ? "super_admin" : "warehouse_worker";
}

function sanitizeAppUserInput(input) {
    const assignedCompaniesSource = Array.isArray(input?.assignedCompanies)
        ? input.assignedCompanies
        : Array.isArray(input?.assigned_companies)
            ? input.assigned_companies
            : [];

    return {
        id: input?.id == null ? "" : String(input.id).trim(),
        email: normalizeEmail(input?.email),
        password: typeof input?.password === "string" ? input.password : "",
        fullName: normalizeFreeText(input?.fullName || input?.full_name || input?.name),
        role: normalizeAppUserRole(input?.role),
        isActive: input?.isActive !== false,
        assignedCompanies: [...new Set(
            assignedCompaniesSource.map((value) => normalizeText(value)).filter(Boolean)
        )]
    };
}

async function saveAppUser(client, rawInput) {
    const entry = sanitizeAppUserInput(rawInput);
    const passwordText = typeof entry.password === "string" ? entry.password : "";
    const existingById = entry.id ? await getAppUserById(client, entry.id) : null;
    const existingByEmail = entry.email ? await getAppUserByEmail(client, entry.email) : null;
    const existing = existingById || existingByEmail;

    if (!entry.email) {
        throw httpError(400, "A valid warehouse user email address is required.");
    }
    if (!entry.fullName) {
        throw httpError(400, "A full name is required.");
    }
    if (!existing && !passwordText.trim()) {
        throw httpError(400, "Set a password the first time you create a warehouse user.");
    }
    if (passwordText && passwordText.length < 8) {
        throw httpError(400, "Warehouse passwords must be at least 8 characters.");
    }
    if (entry.role !== "super_admin" && !entry.assignedCompanies.length) {
        throw httpError(400, "Assign at least one company to warehouse workers.");
    }
    if (existingByEmail && (!existing || String(existingByEmail.id) !== String(existing.id))) {
        throw httpError(400, "That email address is already linked to another warehouse user.");
    }

    const assignedCompanies = entry.role === "super_admin" ? [] : entry.assignedCompanies;
    let savedRow;
    if (existing) {
        const passwordHash = passwordText ? hashPortalPassword(passwordText) : existing.password_hash;
        const result = await client.query(
            `
                update app_users
                set
                    email = $2,
                    password_hash = $3,
                    full_name = $4,
                    role = $5,
                    is_active = $6,
                    updated_at = now()
                where id = $1
                returning *
            `,
            [existing.id, entry.email, passwordHash, entry.fullName, entry.role, entry.isActive !== false]
        );
        savedRow = { ...result.rows[0], was_created: false };
    } else {
        const result = await client.query(
            `
                insert into app_users (email, password_hash, full_name, role, is_active)
                values ($1, $2, $3, $4, $5)
                returning *
            `,
            [entry.email, hashPortalPassword(passwordText), entry.fullName, entry.role, entry.isActive !== false]
        );
        savedRow = { ...result.rows[0], was_created: true };
    }

    await client.query("delete from app_user_company_access where app_user_id = $1", [savedRow.id]);
    for (const accountName of assignedCompanies) {
        await client.query(
            `
                insert into app_user_company_access (app_user_id, account_name)
                values ($1, $2)
                on conflict (app_user_id, account_name) do update
                set updated_at = now()
            `,
            [savedRow.id, accountName]
        );
    }

    return attachAppUserCompanyAssignments(client, savedRow);
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

    const row = await attachAppUserCompanyAssignments(client, result.rows[0]);
    if (!row.is_active) {
        throw httpError(401, "That warehouse login is no longer active.");
    }

    await client.query("update app_sessions set last_seen_at = now() where id = $1", [row.session_id]);
    return { sessionId: String(row.session_id), user: row };
}

function requiresAppAuth(req) {
    const pathName = req.path || req.url || "";
    if (pathName === "/api/health"
        || pathName === "/api/version"
        || pathName === "/api/site/demo-request"
        || pathName === "/api/site/stripe-config"
        || pathName === "/api/site/stripe-checkout-session"
        || pathName === "/api/site/stripe-checkout"
        || pathName === "/api/site/stripe-webhook"
        || pathName === "/api/app/login"
        || pathName === "/api/app/logout"
        || pathName === "/api/app/me") return false;
    if (pathName.startsWith("/api/portal/")) return false;
    return pathName.startsWith("/api/");
}

function mapAppUserRow(row) {
    const assignedCompanies = Array.isArray(row?.assignedCompanies)
        ? row.assignedCompanies
        : Array.isArray(row?.assigned_companies)
            ? row.assigned_companies
            : [];
    return {
        id: String(row.id),
        email: row.email,
        fullName: row.full_name || "",
        role: row.role || "",
        isActive: row.is_active !== false,
        assignedCompanies: [...new Set(assignedCompanies.map((value) => normalizeText(value)).filter(Boolean))],
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

async function getAccessibleCompanyNamesForAppUser(client, user) {
    if (!user || isSuperAdminUser(user)) return [];
    return getAppUserCompanyAssignments(client, user.id || user.app_user_id);
}

async function assertAppUserCompanyAccess(client, user, accountName, message = "") {
    const normalizedAccount = normalizeText(accountName);
    if (!normalizedAccount || !user || isSuperAdminUser(user)) {
        return normalizedAccount;
    }
    const allowedCompanies = await getAccessibleCompanyNamesForAppUser(client, user);
    if (!allowedCompanies.includes(normalizedAccount)) {
        throw httpError(403, message || `Warehouse access for ${normalizedAccount} is not assigned to your login.`);
    }
    return normalizedAccount;
}

function filterRowsByAllowedCompanies(rows, allowedCompanies, selector) {
    if (!Array.isArray(allowedCompanies) || !allowedCompanies.length) return [];
    const allowed = new Set(allowedCompanies.map((value) => normalizeText(value)).filter(Boolean));
    return (Array.isArray(rows) ? rows : []).filter((row) => allowed.has(normalizeText(selector(row))));
}

function sanitizeSiteDemoRequestInput(input) {
    const interests = Array.isArray(input?.interestAreas)
        ? input.interestAreas
        : Array.isArray(input?.interest_areas)
            ? input.interest_areas
            : typeof input?.interestSummary === "string"
                ? input.interestSummary.split(",")
                : [];
    const interestSummary = [...new Set(
        interests
            .map((value) => normalizeFreeText(value))
            .filter(Boolean)
    )].join(", ");

    return {
        fullName: normalizeFreeText(input?.fullName || input?.full_name || input?.name),
        workEmail: normalizeEmail(input?.workEmail || input?.work_email || input?.email),
        companyName: normalizeFreeText(input?.companyName || input?.company_name || input?.company),
        phone: normalizeFreeText(input?.phone),
        roleTitle: normalizeFreeText(input?.roleTitle || input?.role_title || input?.title),
        warehouseCount: normalizeFreeText(input?.warehouseCount || input?.warehouse_count),
        monthlyOrderVolume: normalizeFreeText(input?.monthlyOrderVolume || input?.monthly_order_volume || input?.monthlyVolume),
        operationsType: normalizeFreeText(input?.operationsType || input?.operations_type),
        interestSummary,
        message: normalizeFreeText(input?.message || input?.notes),
        sourcePage: normalizeFreeText(input?.sourcePage || input?.source_page || ""),
        browserLocale: normalizeFreeText(input?.browserLocale || input?.browser_locale || ""),
        website: normalizeFreeText(input?.website || input?.companyWebsite || input?.company_website || "")
    };
}

function mapSiteDemoRequestRow(row) {
    return {
        id: String(row.id),
        fullName: row.full_name || "",
        workEmail: row.work_email || "",
        companyName: row.company_name || "",
        phone: row.phone || "",
        roleTitle: row.role_title || "",
        warehouseCount: row.warehouse_count || "",
        monthlyOrderVolume: row.monthly_order_volume || "",
        operationsType: row.operations_type || "",
        interestSummary: row.interest_summary || "",
        message: row.message || "",
        sourcePage: row.source_page || "",
        browserLocale: row.browser_locale || "",
        ipAddress: row.ip_address || "",
        userAgent: row.user_agent || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
    };
}

async function saveSiteDemoRequest(client, input, requestMeta = {}) {
    const entry = sanitizeSiteDemoRequestInput(input);
    if (!entry.fullName || !entry.workEmail || !entry.companyName) {
        throw httpError(400, "Name, work email, and company are required.");
    }

    const result = await client.query(
        `
            insert into site_demo_requests (
                full_name, work_email, company_name, phone, role_title,
                warehouse_count, monthly_order_volume, operations_type,
                interest_summary, message, source_page, browser_locale,
                ip_address, user_agent
            )
            values (
                $1, $2, $3, $4, $5,
                $6, $7, $8,
                $9, $10, $11, $12,
                $13, $14
            )
            returning *
        `,
        [
            entry.fullName,
            entry.workEmail,
            entry.companyName,
            entry.phone,
            entry.roleTitle,
            entry.warehouseCount,
            entry.monthlyOrderVolume,
            entry.operationsType,
            entry.interestSummary,
            entry.message,
            normalizeFreeText(requestMeta.sourcePage || entry.sourcePage),
            normalizeFreeText(requestMeta.browserLocale || entry.browserLocale),
            normalizeFreeText(requestMeta.ipAddress || ""),
            normalizeFreeText(requestMeta.userAgent || "")
        ]
    );
    return mapSiteDemoRequestRow(result.rows[0]);
}

function normalizeFeedbackRequestType(value) {
    const normalized = normalizeText(value || "BUG");
    return FEEDBACK_REQUEST_TYPES.includes(normalized) ? normalized : "BUG";
}

function normalizeFeedbackSource(value) {
    const normalized = normalizeText(value || "WAREHOUSE");
    return FEEDBACK_SOURCES.includes(normalized) ? normalized : "WAREHOUSE";
}

function normalizeFeedbackStatus(value) {
    const normalized = normalizeText(value || "NEW");
    return FEEDBACK_STATUSES.includes(normalized) ? normalized : "NEW";
}

function sanitizeFeedbackLongText(value, maxLength = 4000) {
    const text = String(value || "")
        .replace(/\u0000/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trim();
    if (!text) return "";
    return text.slice(0, maxLength);
}

function sanitizeFeedbackSubmissionInput(input) {
    return {
        requestType: normalizeFeedbackRequestType(input?.requestType || input?.type),
        title: normalizeFreeText(input?.title || input?.subject || "").slice(0, 180),
        details: sanitizeFeedbackLongText(input?.details || input?.message || input?.description, 8000),
        accountName: normalizeText(input?.accountName || input?.owner || input?.company || input?.customer || ""),
        pageName: normalizeFreeText(input?.pageName || input?.page || input?.view || "").slice(0, 160),
        appSection: normalizeText(input?.appSection || input?.section || ""),
        pageUrl: String(input?.pageUrl || input?.url || "").trim().slice(0, 600),
        buildLabel: normalizeFreeText(input?.buildLabel || "").slice(0, 160),
        browserInfo: sanitizeFeedbackLongText(input?.browserInfo || "", 1000),
        status: normalizeFeedbackStatus(input?.status || "NEW"),
        adminNote: sanitizeFeedbackLongText(input?.adminNote || input?.note || "", 2000)
    };
}

function mapFeedbackSubmissionRow(row) {
    return {
        id: String(row.id),
        requestType: normalizeFeedbackRequestType(row.request_type),
        source: normalizeFeedbackSource(row.source),
        accountName: row.account_name || "",
        submittedByEmail: row.submitted_by_email || "",
        submittedByName: row.submitted_by_name || "",
        submittedByRole: row.submitted_by_role || "",
        title: row.title || "",
        details: row.details || "",
        pageName: row.page_name || "",
        appSection: row.app_section || "",
        pageUrl: row.page_url || "",
        buildLabel: row.build_label || "",
        browserInfo: row.browser_info || "",
        ipAddress: row.ip_address || "",
        status: normalizeFeedbackStatus(row.status),
        adminNote: row.admin_note || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
    };
}

async function saveFeedbackSubmission(client, input, requestMeta = {}) {
    const entry = sanitizeFeedbackSubmissionInput(input);
    if (!entry.title) {
        throw httpError(400, "A short title is required.");
    }
    if (!entry.details) {
        throw httpError(400, "Add a few details so the team can reproduce or review this request.");
    }

    const requestType = normalizeFeedbackRequestType(requestMeta.requestType || entry.requestType);
    const source = normalizeFeedbackSource(requestMeta.source || "WAREHOUSE");
    const status = normalizeFeedbackStatus(requestMeta.status || entry.status || "NEW");
    const result = await client.query(
        `
            insert into feedback_submissions (
                request_type,
                source,
                account_name,
                submitted_by_email,
                submitted_by_name,
                submitted_by_role,
                title,
                details,
                page_name,
                app_section,
                page_url,
                build_label,
                browser_info,
                ip_address,
                status,
                admin_note
            )
            values (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16
            )
            returning *
        `,
        [
            requestType,
            source,
            normalizeText(requestMeta.accountName || entry.accountName || ""),
            normalizeEmail(requestMeta.submittedByEmail || ""),
            normalizeFreeText(requestMeta.submittedByName || ""),
            normalizeText(requestMeta.submittedByRole || ""),
            entry.title,
            entry.details,
            entry.pageName,
            entry.appSection,
            entry.pageUrl,
            normalizeFreeText(requestMeta.buildLabel || entry.buildLabel || APP_BUILD_INFO.label || ""),
            entry.browserInfo,
            normalizeFreeText(requestMeta.ipAddress || ""),
            status,
            requestMeta.allowAdminNote === true ? entry.adminNote : ""
        ]
    );
    return mapFeedbackSubmissionRow(result.rows[0]);
}

async function listFeedbackSubmissions(client, filters = {}) {
    const requestedStatus = normalizeText(filters.status || "");
    const requestedType = normalizeText(filters.requestType || filters.type || "");
    const requestedSource = normalizeText(filters.source || "");
    const requestedAccount = normalizeText(filters.accountName || filters.account_name || "");
    const requestedSearch = sanitizeFeedbackLongText(filters.query || filters.search || "", 200);
    const clauses = [];
    const params = [];

    if (requestedStatus && FEEDBACK_STATUSES.includes(requestedStatus)) {
        params.push(requestedStatus);
        clauses.push(`status = $${params.length}`);
    }
    if (requestedType && FEEDBACK_REQUEST_TYPES.includes(requestedType)) {
        params.push(requestedType);
        clauses.push(`request_type = $${params.length}`);
    }
    if (requestedSource && FEEDBACK_SOURCES.includes(requestedSource)) {
        params.push(requestedSource);
        clauses.push(`source = $${params.length}`);
    }
    if (requestedAccount) {
        params.push(requestedAccount);
        clauses.push(`account_name = $${params.length}`);
    }
    if (requestedSearch) {
        params.push(`%${requestedSearch}%`);
        clauses.push(`(
            title ilike $${params.length}
            or details ilike $${params.length}
            or account_name ilike $${params.length}
            or submitted_by_email ilike $${params.length}
            or submitted_by_name ilike $${params.length}
            or page_name ilike $${params.length}
        )`);
    }

    const result = await client.query(
        `
            select *
            from feedback_submissions
            ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
            order by created_at desc, id desc
            limit 250
        `,
        params
    );
    return result.rows.map(mapFeedbackSubmissionRow);
}

async function updateFeedbackSubmissionStatus(client, feedbackId, input, _actingUser = null) {
    const normalizedId = Number.parseInt(String(feedbackId || ""), 10);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        throw httpError(400, "A valid feedback id is required.");
    }

    const entry = sanitizeFeedbackSubmissionInput(input);
    const status = normalizeFeedbackStatus(input?.status || entry.status || "NEW");

    const result = await client.query(
        `
            update feedback_submissions
            set status = $2,
                admin_note = $3,
                updated_at = now()
            where id = $1
            returning *
        `,
        [normalizedId, status, entry.adminNote]
    );
    if (result.rowCount !== 1) {
        throw httpError(404, "That feedback request could not be found.");
    }
    return mapFeedbackSubmissionRow(result.rows[0]);
}

async function getOwnerAccountRowByName(client, accountName) {
    const normalizedAccount = normalizeText(accountName);
    if (!normalizedAccount) return null;
    const result = await client.query("select * from owner_accounts where name = $1 limit 1", [normalizedAccount]);
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function assertCompanyFeatureEnabled(client, accountName, featureKey, message = "") {
    const ownerRow = await getOwnerAccountRowByName(client, accountName);
    const featureFlags = ownerRow
        ? assertCompanyFeatureEnabledForOwnerRow(ownerRow, featureKey, message)
        : resolveCompanyFeatureFlags(null, { legacyMode: false });
    if (!ownerRow && featureFlags[featureKey] !== true) {
        throw httpError(403, message || getCompanyFeatureErrorMessage(featureKey, accountName));
    }
    return featureFlags;
}

async function getPortalAccessList(client = pool) {
    const result = await client.query("select * from portal_vendor_access order by account_name asc, email asc, id asc");
    return result.rows.map(mapPortalAccessRow);
}

async function getPortalOrderAccountNameById(client, orderId) {
    const result = await client.query("select account_name from portal_orders where id = $1 limit 1", [orderId]);
    if (result.rowCount !== 1) {
        throw httpError(404, "That order could not be found.");
    }
    return normalizeText(result.rows[0].account_name);
}

async function getBillingEventAccountNamesByIds(client, ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const result = await client.query(
        "select distinct account_name from billing_events where id = any($1::bigint[]) and account_name <> ''",
        [ids]
    );
    return result.rows.map((row) => normalizeText(row.account_name)).filter(Boolean);
}

async function getStoreIntegrationList(client = pool, accountName = "") {
    const normalizedAccount = normalizeText(accountName);
    const result = normalizedAccount
        ? await client.query("select * from store_integrations where account_name = $1 order by account_name asc, provider asc, integration_name asc, id asc", [normalizedAccount])
        : await client.query("select * from store_integrations order by account_name asc, provider asc, integration_name asc, id asc");
    return result.rows.map(mapStoreIntegrationRow);
}

async function getStoreIntegrationRowById(client, integrationId) {
    const result = await client.query("select * from store_integrations where id = $1 limit 1", [integrationId]);
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function saveStoreIntegration(client, rawInput) {
    const entry = sanitizeStoreIntegrationInput(rawInput);
    if (!entry.accountName) {
        throw httpError(400, "Company is required.");
    }
    if (!entry.provider) {
        throw httpError(400, "Choose a supported provider.");
    }
    if (!entry.storeIdentifier) {
        throw httpError(400, entry.provider === SHOPIFY_SYNC_PROVIDER
            ? "Enter the Shopify shop domain, such as your-store.myshopify.com."
            : (entry.provider === SFTP_SYNC_PROVIDER
                ? "Enter the SFTP host name or IP address for this integration."
                : "Enter the store identifier or URL for this integration."));
    }

    const existing = entry.integrationId ? await getStoreIntegrationRowById(client, entry.integrationId) : null;
    if (entry.integrationId && !existing) {
        throw httpError(404, "That integration record could not be found.");
    }

    const normalizedName = entry.integrationName || `${describeStoreIntegrationProvider(entry.provider)} ${entry.storeIdentifier}`;
    const accessToken = entry.accessToken || existing?.access_token || "";
    const authClientId = entry.provider === SHOPIFY_SYNC_PROVIDER
        ? (entry.authClientId || existing?.auth_client_id || "")
        : "";
    const authClientSecret = entry.provider === SHOPIFY_SYNC_PROVIDER
        ? (entry.authClientSecret || existing?.auth_client_secret || "")
        : "";
    const replacingShopifyClientCredentials = entry.provider === SHOPIFY_SYNC_PROVIDER && !!entry.authClientId && !!entry.authClientSecret;
    const storedAccessToken = replacingShopifyClientCredentials && !entry.accessToken ? "" : accessToken;
    const accessTokenExpiresAt = entry.provider === SHOPIFY_SYNC_PROVIDER
        ? (entry.accessToken ? null : (storedAccessToken ? (existing?.access_token_expires_at || null) : null))
        : null;
    const shouldResetSyncState = !existing
        || existing.provider !== entry.provider
        || existing.store_identifier !== entry.storeIdentifier
        || JSON.stringify(sanitizeStoreIntegrationSettingsInput(existing?.provider || entry.provider, existing?.settings || {}))
            !== JSON.stringify(entry.settings || {})
        || (entry.accessToken && entry.accessToken !== existing.access_token)
        || (entry.authClientId && entry.authClientId !== existing?.auth_client_id)
        || (entry.authClientSecret && entry.authClientSecret !== existing?.auth_client_secret);

    if (entry.provider === SHOPIFY_SYNC_PROVIDER) {
        if (!entry.storeIdentifier.endsWith(".myshopify.com")) {
            throw httpError(400, "Shopify connections must use the shop's .myshopify.com domain.");
        }
        if ((entry.authClientId && !entry.authClientSecret) || (!entry.authClientId && entry.authClientSecret)) {
            throw httpError(400, "Enter both the Shopify client ID and client secret when updating client credentials.");
        }
        if (!storedAccessToken && !(authClientId && authClientSecret)) {
            throw httpError(400, "Enter either a Shopify Admin API access token or the Shopify client credentials.");
        }
    }
    if (entry.provider === SFTP_SYNC_PROVIDER) {
        if (!entry.settings?.username) {
            throw httpError(400, "An SFTP username is required.");
        }
        if (!accessToken) {
            throw httpError(400, "An SFTP password is required.");
        }
        if (!entry.settings?.ordersFolder
            && !entry.settings?.inboundsFolder
            && !entry.settings?.shipmentsFolder
            && !entry.settings?.receiptsFolder
            && !entry.settings?.inventoryFolder) {
            throw httpError(400, "Set at least one SFTP import or export folder before saving this connection.");
        }
    }
    if (entry.syncSchedule !== "MANUAL" && !storeIntegrationProviderSupportsAutoSync(entry.provider)) {
        throw httpError(400, `${describeStoreIntegrationProvider(entry.provider)} auto sync is not wired in yet. Save this provider as manual first.`);
    }

    const preservedLastSyncedAt = shouldResetSyncState ? null : (existing?.last_synced_at || null);
    const nextScheduledSyncAt = entry.isActive
        ? computeNextStoreIntegrationSyncAt(entry.syncSchedule, { lastSyncedAt: preservedLastSyncedAt })
        : null;

    let savedRow;
    try {
        if (existing) {
            const updateResult = await client.query(
                `
                    update store_integrations
                    set
                        account_name = $2,
                        provider = $3,
                        integration_name = $4,
                        store_identifier = $5,
                        access_token = $6,
                        access_token_expires_at = $7,
                        auth_client_id = $8,
                        auth_client_secret = $9,
                        settings = $10,
                        import_status = $11,
                        is_active = $12,
                        sync_schedule = $13,
                        next_scheduled_sync_at = $14,
                        last_synced_at = $15,
                        last_sync_status = $16,
                        last_sync_message = $17,
                        updated_at = now()
                    where id = $1
                    returning *
                `,
                [
                    existing.id,
                    entry.accountName,
                    entry.provider,
                    normalizedName,
                    entry.storeIdentifier,
                    storedAccessToken,
                    accessTokenExpiresAt,
                    authClientId,
                    authClientSecret,
                    entry.settings || {},
                    entry.importStatus,
                    entry.isActive,
                    entry.syncSchedule,
                    nextScheduledSyncAt,
                    preservedLastSyncedAt,
                    shouldResetSyncState ? "IDLE" : (existing.last_sync_status || "IDLE"),
                    shouldResetSyncState ? "" : (existing.last_sync_message || "")
                ]
            );
            savedRow = updateResult.rows[0];
        } else {
            const insertResult = await client.query(
                `
                    insert into store_integrations (
                        account_name, provider, integration_name, store_identifier,
                        access_token, access_token_expires_at, auth_client_id, auth_client_secret, settings, import_status, is_active, sync_schedule, next_scheduled_sync_at
                    )
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    returning *
                `,
                [
                    entry.accountName,
                    entry.provider,
                    normalizedName,
                    entry.storeIdentifier,
                    storedAccessToken,
                    accessTokenExpiresAt,
                    authClientId,
                    authClientSecret,
                    entry.settings || {},
                    entry.importStatus,
                    entry.isActive,
                    entry.syncSchedule,
                    nextScheduledSyncAt
                ]
            );
            savedRow = insertResult.rows[0];
        }
    } catch (error) {
        if (error?.code === "23505") {
            throw httpError(409, "That company already has the same store connection saved.");
        }
        throw error;
    }

    const mapped = mapStoreIntegrationRow(savedRow);
    mapped.wasCreated = !existing;
    return mapped;
}

async function syncStoreIntegrationById(integrationId, appUser = null) {
    const lockKey = String(toPositiveInt(integrationId) || "");
    if (!lockKey) {
        throw httpError(400, "A valid integration id is required.");
    }
    if (storeIntegrationSyncLocks.has(lockKey)) {
        throw httpError(409, "This integration is already syncing. Please wait a moment and try again.");
    }

    storeIntegrationSyncLocks.add(lockKey);
    try {
        const integrationRow = await getStoreIntegrationRowById(pool, integrationId);
        if (!integrationRow) {
            throw httpError(404, "That integration record could not be found.");
        }
        if (integrationRow.is_active !== true) {
            throw httpError(400, "Enable the integration before pulling orders.");
        }
        await assertCompanyFeatureEnabled(pool, integrationRow.account_name, COMPANY_FEATURE_KEYS.STORE_INTEGRATIONS);
        if (normalizeStoreIntegrationProvider(integrationRow.provider) === SHOPIFY_SYNC_PROVIDER) {
            await assertCompanyFeatureEnabled(pool, integrationRow.account_name, COMPANY_FEATURE_KEYS.SHOPIFY_INTEGRATION);
        }
        if (normalizeStoreIntegrationProvider(integrationRow.provider) === SFTP_SYNC_PROVIDER) {
            await assertCompanyFeatureEnabled(pool, integrationRow.account_name, COMPANY_FEATURE_KEYS.SFTP_INTEGRATION);
        }

        try {
            if (normalizeStoreIntegrationProvider(integrationRow.provider) === SFTP_SYNC_PROVIDER) {
                return await syncSftpIntegration(integrationRow, appUser);
            }

            const fetchedOrders = await fetchStoreOrdersForIntegration(integrationRow);
            return withTransaction(async (client) => importStoreOrdersForIntegration(client, integrationRow, fetchedOrders, appUser));
        } catch (error) {
            const nextScheduledSyncAt = computeNextStoreIntegrationSyncAt(integrationRow.sync_schedule, { lastSyncedAt: new Date() });
            await pool.query(
                `
                    update store_integrations
                    set last_sync_status = 'ERROR',
                        last_sync_message = $2,
                        next_scheduled_sync_at = $3,
                        updated_at = now()
                    where id = $1
                `,
                [integrationId, truncateStoreSyncMessage(error.message || "Store sync failed."), nextScheduledSyncAt]
            );
            throw error;
        }
    } finally {
        storeIntegrationSyncLocks.delete(lockKey);
    }
}

async function importStoreOrdersForIntegration(client, integrationRow, orders, appUser = null) {
    const normalizedProvider = normalizeStoreIntegrationProvider(integrationRow.provider);
    const externalIds = orders
        .map((order) => String(order?.id || "").trim())
        .filter(Boolean);
    const existingImports = externalIds.length
        ? await client.query(
            "select external_order_id from store_order_imports where integration_id = $1 and external_order_id = any($2::text[])",
            [integrationRow.id, externalIds]
        )
        : { rows: [] };
    const existingIds = new Set(existingImports.rows.map((row) => row.external_order_id));

    let importedCount = 0;
    let releasedCount = 0;
    let draftCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const detailMessages = [];

    for (const order of orders) {
        const externalOrderId = String(order?.id || "").trim();
        const orderLabel = normalizeFreeText(order?.name || order?.order_number || externalOrderId || "Store order");
        if (!externalOrderId) {
            failedCount += 1;
            detailMessages.push("Encountered a store order without an external id.");
            continue;
        }
        if (existingIds.has(externalOrderId)) {
            skippedCount += 1;
            continue;
        }

        try {
            let importedOrder = null;
            if (normalizedProvider === SHOPIFY_SYNC_PROVIDER) {
                const payload = mapShopifyOrderToPortalDraft(integrationRow.account_name, order, integrationRow);
                importedOrder = await savePortalOrderDraftForAccount(
                    client,
                    integrationRow.account_name,
                    payload,
                    null,
                    {
                        portalAccessId: null,
                        downloadPathPrefix: "/api/admin/portal-order-documents",
                        activityTitlePrefix: "store import",
                        activityActor: `${describeStoreIntegrationProvider(normalizedProvider)} ${integrationRow.integration_name || integrationRow.store_identifier}`,
                        enforceInventoryAvailability: false
                    }
                );
            } else {
                throw httpError(400, `${describeStoreIntegrationProvider(normalizedProvider)} order import is not wired in yet.`);
            }

            let finalOrder = importedOrder;
            if ((integrationRow.import_status || "DRAFT") === "RELEASED") {
                try {
                    finalOrder = await releaseWarehousePortalOrder(client, importedOrder.id, appUser);
                    releasedCount += 1;
                } catch (error) {
                    draftCount += 1;
                    detailMessages.push(`${orderLabel} imported as draft: ${error.message}`);
                }
            } else {
                draftCount += 1;
            }

            await client.query(
                `
                    insert into store_order_imports (integration_id, external_order_id, portal_order_id)
                    values ($1, $2, $3)
                `,
                [integrationRow.id, externalOrderId, finalOrder.id]
            );
            importedCount += 1;
        } catch (error) {
            failedCount += 1;
            detailMessages.push(`${orderLabel}: ${error.message}`);
        }
    }

    if (existingIds.size > 0) {
        await client.query(
            "update store_order_imports set last_seen_at = now() where integration_id = $1 and external_order_id = any($2::text[])",
            [integrationRow.id, [...existingIds]]
        );
    }

    const status = failedCount > 0
        ? ((importedCount > 0 || skippedCount > 0) ? "WARNING" : "ERROR")
        : "SUCCESS";
    const baseMessage = [
        `Fetched ${orders.length} ${normalizedProvider === SHOPIFY_SYNC_PROVIDER ? "Shopify" : "store"} order${orders.length === 1 ? "" : "s"}.`,
        `Imported ${importedCount}.`,
        `Released ${releasedCount}.`,
        `Drafts ${draftCount}.`,
        `Skipped ${skippedCount}.`,
        `Failed ${failedCount}.`
    ].join(" ");
    const summaryMessage = detailMessages.length
        ? `${baseMessage} ${truncateStoreSyncMessage(detailMessages.slice(0, 3).join(" | "), 380)}`
        : baseMessage;

    const updatedResult = await client.query(
        `
            update store_integrations
            set
                last_synced_at = now(),
                last_sync_status = $2,
                last_sync_message = $3,
                next_scheduled_sync_at = $4,
                updated_at = now()
            where id = $1
            returning *
        `,
        [
            integrationRow.id,
            status,
            truncateStoreSyncMessage(summaryMessage),
            computeNextStoreIntegrationSyncAt(integrationRow.sync_schedule, { lastSyncedAt: new Date() })
        ]
    );

    await insertActivity(
        client,
        "order",
        `Synced ${describeStoreIntegrationProvider(normalizedProvider)} orders for ${integrationRow.account_name}`,
        [
            integrationRow.store_identifier,
            `Imported ${importedCount}`,
            `Released ${releasedCount}`,
            `Drafts ${draftCount}`,
            `Skipped ${skippedCount}`,
            `Failed ${failedCount}`
        ].join(" | ")
    );

    return {
        integration: mapStoreIntegrationRow(updatedResult.rows[0]),
        ordersFetched: orders.length,
        importedCount,
        releasedCount,
        draftCount,
        skippedCount,
        failedCount,
        message: truncateStoreSyncMessage(summaryMessage)
    };
}

async function fetchStoreOrdersForIntegration(integrationRow) {
    const provider = normalizeStoreIntegrationProvider(integrationRow.provider);
    if (provider === SHOPIFY_SYNC_PROVIDER) {
        return fetchShopifyOrdersForIntegration(integrationRow);
    }
    throw httpError(400, `${describeStoreIntegrationProvider(provider)} order pull is not wired in yet.`);
}

function integrationHasShopifyClientCredentials(integrationRow) {
    return !!(
        String(integrationRow?.auth_client_id || "").trim()
        && String(integrationRow?.auth_client_secret || "").trim()
    );
}

function canReuseIntegrationAccessToken(integrationRow, { minimumMs = 5 * 60 * 1000 } = {}) {
    const accessToken = String(integrationRow?.access_token || "").trim();
    if (!accessToken) return false;
    const expiresAt = integrationRow?.access_token_expires_at ? new Date(integrationRow.access_token_expires_at) : null;
    if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
        return true;
    }
    return expiresAt.getTime() - Date.now() > minimumMs;
}

async function refreshShopifyAccessTokenForIntegration(integrationRow) {
    const shopDomain = normalizeStoreIdentifierForProvider(SHOPIFY_SYNC_PROVIDER, integrationRow?.store_identifier);
    const clientId = String(integrationRow?.auth_client_id || "").trim();
    const clientSecret = String(integrationRow?.auth_client_secret || "").trim();

    if (!shopDomain || !shopDomain.endsWith(".myshopify.com")) {
        throw httpError(400, "This Shopify connection is missing a valid .myshopify.com domain.");
    }
    if (!clientId || !clientSecret) {
        throw httpError(400, "This Shopify connection is missing its client credentials.");
    }

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret
        }).toString(),
        signal: AbortSignal.timeout(30000)
    });

    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch (_error) {
        payload = {};
    }

    if (!response.ok) {
        const details = payload?.error_description
            || payload?.error
            || (payload?.errors ? JSON.stringify(payload.errors) : "")
            || text
            || response.statusText
            || "Shopify token request failed.";
        throw httpError(response.status === 401 || response.status === 403 ? 401 : 502, `Shopify token request failed: ${details}`);
    }

    const accessToken = String(payload?.access_token || "").trim();
    if (!accessToken) {
        throw httpError(502, "Shopify did not return an Admin API access token.");
    }
    const expiresInSeconds = toPositiveInt(payload?.expires_in) || (24 * 60 * 60);
    const expiresAtIso = new Date(Date.now() + (expiresInSeconds * 1000)).toISOString();
    const updateResult = await pool.query(
        `
            update store_integrations
            set access_token = $2,
                access_token_expires_at = $3,
                updated_at = now()
            where id = $1
            returning *
        `,
        [integrationRow.id, accessToken, expiresAtIso]
    );
    return updateResult.rowCount === 1
        ? updateResult.rows[0]
        : { ...integrationRow, access_token: accessToken, access_token_expires_at: expiresAtIso };
}

async function resolveShopifyAccessTokenForIntegration(integrationRow, { forceRefresh = false } = {}) {
    if (!forceRefresh && canReuseIntegrationAccessToken(integrationRow)) {
        return {
            integrationRow,
            accessToken: String(integrationRow.access_token || "").trim()
        };
    }
    if (integrationHasShopifyClientCredentials(integrationRow)) {
        const refreshedIntegrationRow = await refreshShopifyAccessTokenForIntegration(integrationRow);
        return {
            integrationRow: refreshedIntegrationRow,
            accessToken: String(refreshedIntegrationRow.access_token || "").trim()
        };
    }
    const accessToken = String(integrationRow?.access_token || "").trim();
    if (!accessToken) {
        throw httpError(400, "This Shopify connection is missing both an Admin API access token and client credentials.");
    }
    return {
        integrationRow,
        accessToken
    };
}

async function fetchShopifyOrdersForIntegration(integrationRow) {
    const fields = [
        "id",
        "name",
        "order_number",
        "po_number",
        "created_at",
        "processed_at",
        "email",
        "phone",
        "tags",
        "note",
        "shipping_address",
        "billing_address",
        "customer",
        "line_items",
        "cancelled_at",
        "fulfillment_status",
        "financial_status"
    ].join(",");

    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const resolved = await resolveShopifyAccessTokenForIntegration(integrationRow, { forceRefresh });
        const activeIntegrationRow = resolved.integrationRow || integrationRow;
        const shopDomain = normalizeStoreIdentifierForProvider(SHOPIFY_SYNC_PROVIDER, activeIntegrationRow.store_identifier);
        const accessToken = String(resolved.accessToken || "").trim();

        if (!shopDomain || !shopDomain.endsWith(".myshopify.com")) {
            throw httpError(400, "This Shopify connection is missing a valid .myshopify.com domain.");
        }
        if (!accessToken) {
            throw httpError(400, "This Shopify connection is missing its Shopify access credential.");
        }

        let nextUrl = new URL(`https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/orders.json`);
        nextUrl.searchParams.set("status", "open");
        nextUrl.searchParams.set("limit", String(SHOPIFY_ORDER_PAGE_LIMIT));
        nextUrl.searchParams.set("fields", fields);

        const collected = [];
        let pageCount = 0;
        let shouldRetryWithFreshToken = false;

        while (nextUrl) {
            pageCount += 1;
            if (pageCount > 8) {
                break;
            }

            const response = await fetch(nextUrl, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    "X-Shopify-Access-Token": accessToken
                },
                signal: AbortSignal.timeout(30000)
            });

            const text = await response.text();
            let payload = {};
            try {
                payload = text ? JSON.parse(text) : {};
            } catch (_error) {
                payload = {};
            }

            if (!response.ok) {
                if ((response.status === 401 || response.status === 403) && integrationHasShopifyClientCredentials(activeIntegrationRow) && !forceRefresh) {
                    shouldRetryWithFreshToken = true;
                    break;
                }
                const details = payload?.errors
                    ? (typeof payload.errors === "string" ? payload.errors : JSON.stringify(payload.errors))
                    : (text || response.statusText || "Shopify request failed.");
                throw httpError(response.status === 401 || response.status === 403 ? 401 : 502, `Shopify request failed: ${details}`);
            }

            const orders = Array.isArray(payload?.orders) ? payload.orders : [];
            collected.push(...orders.filter((order) => !order?.cancelled_at));
            nextUrl = parseShopifyNextLink(response.headers.get("link"));
        }

        if (!shouldRetryWithFreshToken) {
            return collected;
        }
        forceRefresh = true;
        integrationRow = activeIntegrationRow;
    }

    throw httpError(401, "Shopify access token refresh failed.");
}

function parseShopifyNextLink(linkHeader) {
    const text = String(linkHeader || "");
    if (!text) return null;
    const match = text.match(/<([^>]+)>;\s*rel="next"/i);
    return match?.[1] ? new URL(match[1]) : null;
}

function mapShopifyOrderToPortalDraft(accountName, order, integrationRow) {
    const shipping = order?.shipping_address && typeof order.shipping_address === "object" ? order.shipping_address : null;
    const billing = order?.billing_address && typeof order.billing_address === "object" ? order.billing_address : null;
    const customer = order?.customer && typeof order.customer === "object" ? order.customer : null;
    const fallbackAddress = customer?.default_address && typeof customer.default_address === "object" ? customer.default_address : null;
    const address = shipping || billing || fallbackAddress || {};
    const shipToName = normalizeFreeText(
        address?.name
        || [address?.first_name, address?.last_name].filter(Boolean).join(" ")
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(" ")
        || order?.email
        || `Shopify ${order?.name || order?.id || "Order"}`
    );
    const contactPhone = normalizeFreeText(address?.phone || order?.phone || customer?.phone || order?.email || "NO PHONE");
    const lines = (Array.isArray(order?.line_items) ? order.line_items : [])
        .map((line) => ({
            sku: normalizeText(line?.sku || ""),
            quantity: toPositiveInt(line?.fulfillable_quantity ?? line?.current_quantity ?? line?.quantity)
        }))
        .filter((line) => line.sku && line.quantity);

    if (!lines.length) {
        throw httpError(400, `Shopify order ${normalizeFreeText(order?.name || order?.id || "")} does not have any shippable SKU lines to import.`);
    }

    const shipToAddress1 = normalizeFreeText(address?.address1 || "");
    const shipToCity = normalizeFreeText(address?.city || "");
    const shipToState = normalizeFreeText(address?.province_code || address?.province || "");
    const shipToPostalCode = normalizeFreeText(address?.zip || address?.postal_code || "");
    const shipToCountry = normalizeFreeText(address?.country_code || address?.country || "USA");
    if (!shipToAddress1 || !shipToCity || !shipToState || !shipToPostalCode || !shipToCountry) {
        throw httpError(400, `Shopify order ${normalizeFreeText(order?.name || order?.id || "")} is missing a full ship-to address.`);
    }

    return {
        accountName,
        poNumber: normalizeFreeText(order?.po_number || order?.name || String(order?.order_number || order?.id || "")),
        shippingReference: normalizeFreeText(order?.name || `SHOPIFY-${order?.order_number || order?.id || ""}`),
        contactName: shipToName,
        contactPhone,
        requestedShipDate: normalizeDateInput(order?.processed_at || order?.created_at || new Date().toISOString()),
        orderNotes: normalizeFreeText([
            `Imported from Shopify`,
            integrationRow?.store_identifier || "",
            order?.name ? `External order ${order.name}` : "",
            order?.email ? `Customer ${order.email}` : "",
            order?.financial_status ? `Payment ${order.financial_status}` : "",
            order?.tags ? `Tags ${order.tags}` : "",
            order?.note || ""
        ].filter(Boolean).join(" | ")),
        shipToName,
        shipToAddress1,
        shipToAddress2: normalizeFreeText(address?.address2 || ""),
        shipToCity,
        shipToState,
        shipToPostalCode,
        shipToCountry,
        shipToPhone: contactPhone,
        lines
    };
}

function buildSftpConnectionConfig(integrationRow) {
    const settings = sanitizeStoreIntegrationSettingsInput(integrationRow.provider, integrationRow.settings || {});
    const host = normalizeStoreIdentifierForProvider(SFTP_SYNC_PROVIDER, integrationRow.store_identifier);
    if (!host) {
        throw httpError(400, "This SFTP connection is missing its host name.");
    }
    if (!settings.username) {
        throw httpError(400, "This SFTP connection is missing its username.");
    }
    const password = String(integrationRow.access_token || "").trim();
    if (!password) {
        throw httpError(400, "This SFTP connection is missing its password.");
    }

    return {
        host,
        port: toPositiveInt(settings.port) || SFTP_DEFAULT_PORT,
        username: settings.username,
        password,
        readyTimeout: 30000
    };
}

async function connectSftpForIntegration(integrationRow) {
    if (!SftpClient) {
        throw httpError(500, "SFTP support is not installed on this build yet. Redeploy after dependencies install.");
    }
    const client = new SftpClient();
    try {
        await client.connect(buildSftpConnectionConfig(integrationRow));
    } catch (error) {
        try {
            await client.end();
        } catch (_closeError) {
            // Ignore close errors when the connection never came up.
        }
        throw httpError(502, `SFTP connection failed: ${error.message || "Unable to connect."}`);
    }
    return client;
}

function joinSftpRemotePath(basePath, childName = "") {
    const normalizedBase = normalizeRemoteFolderPath(basePath);
    const normalizedChild = String(childName || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedBase) {
        return normalizedChild ? `/${normalizedChild}` : "";
    }
    return normalizedChild ? path.posix.join(normalizedBase, normalizedChild) : normalizedBase;
}

async function ensureSftpDirectory(client, remoteFolder) {
    const normalizedFolder = normalizeRemoteFolderPath(remoteFolder);
    if (!normalizedFolder) return;
    const exists = await client.exists(normalizedFolder);
    if (exists === "d") return;
    if (exists && exists !== "d") {
        throw httpError(400, `${normalizedFolder} already exists on SFTP but is not a folder.`);
    }
    await client.mkdir(normalizedFolder, true);
}

async function listSftpJsonFiles(client, remoteFolder) {
    const normalizedFolder = normalizeRemoteFolderPath(remoteFolder);
    if (!normalizedFolder) return [];
    const exists = await client.exists(normalizedFolder);
    if (exists !== "d") {
        return [];
    }
    const entries = await client.list(normalizedFolder);
    return entries
        .filter((entry) => entry?.type === "-" && /\.json$/i.test(String(entry.name || "")))
        .map((entry) => ({
            name: String(entry.name || "").trim(),
            path: joinSftpRemotePath(normalizedFolder, entry.name),
            size: Number(entry.size) || 0,
            modifyTime: Number(entry.modifyTime) || 0
        }))
        .sort((left, right) => left.modifyTime - right.modifyTime || left.name.localeCompare(right.name));
}

async function readSftpJsonFile(client, remoteFilePath) {
    const fileBuffer = await client.get(remoteFilePath);
    const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer || "");
    const text = buffer.toString("utf8");
    try {
        return text ? JSON.parse(text) : {};
    } catch (_error) {
        throw httpError(400, `${path.posix.basename(remoteFilePath)} is not valid JSON.`);
    }
}

function extractSftpPayloadEntries(payload, collectionKey, fileLabel) {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (payload && typeof payload === "object") {
        const directCollection = payload[collectionKey];
        if (Array.isArray(directCollection)) {
            return directCollection;
        }
        return [payload];
    }
    throw httpError(400, `${fileLabel} does not contain a valid ${collectionKey} payload.`);
}

function getSftpExternalId(rawValue, fallback = "") {
    const text = String(rawValue || fallback || "").trim();
    return text.slice(0, 160);
}

function mapSftpOrderToPortalDraft(accountName, rawOrder, sourceContext = {}) {
    const shipTo = rawOrder?.shipTo && typeof rawOrder.shipTo === "object"
        ? rawOrder.shipTo
        : (rawOrder?.ship_to && typeof rawOrder.ship_to === "object"
            ? rawOrder.ship_to
            : (rawOrder?.shippingAddress && typeof rawOrder.shippingAddress === "object"
                ? rawOrder.shippingAddress
                : {}));
    const contact = rawOrder?.contact && typeof rawOrder.contact === "object"
        ? rawOrder.contact
        : (rawOrder?.customer && typeof rawOrder.customer === "object" ? rawOrder.customer : {});
    const externalOrderId = getSftpExternalId(
        rawOrder?.externalOrderId
        || rawOrder?.external_order_id
        || rawOrder?.externalId
        || rawOrder?.orderId
        || rawOrder?.order_id
        || rawOrder?.id,
        `${sourceContext.fileName || "order"}-${sourceContext.index || 1}`
    );
    const lines = (Array.isArray(rawOrder?.lines) ? rawOrder.lines : (Array.isArray(rawOrder?.items) ? rawOrder.items : []))
        .map((line) => ({
            sku: normalizeText(line?.sku || line?.itemSku || line?.item_sku || line?.code || ""),
            quantity: toPositiveInt(line?.quantity || line?.qty || line?.orderedQuantity || line?.ordered_quantity)
        }))
        .filter((line) => line.sku && line.quantity);

    if (!externalOrderId) {
        throw httpError(400, `${sourceContext.fileName || "SFTP order"} is missing an external order id.`);
    }
    if (!lines.length) {
        throw httpError(400, `${externalOrderId} does not contain any shippable lines.`);
    }

    const shipToName = normalizeFreeText(
        rawOrder?.shipToName
        || rawOrder?.ship_to_name
        || shipTo?.name
        || [shipTo?.firstName || shipTo?.first_name, shipTo?.lastName || shipTo?.last_name].filter(Boolean).join(" ")
        || rawOrder?.contactName
        || rawOrder?.contact_name
        || contact?.name
        || "SFTP Import"
    );
    const contactPhone = normalizeFreeText(rawOrder?.contactPhone || rawOrder?.contact_phone || contact?.phone || shipTo?.phone || rawOrder?.phone || "");
    const requestedShipDate = normalizeDateInput(rawOrder?.requestedShipDate || rawOrder?.requested_ship_date || rawOrder?.shipDate || rawOrder?.ship_date || rawOrder?.createdAt || rawOrder?.created_at || new Date());

    return {
        externalOrderId,
        label: normalizeFreeText(rawOrder?.shippingReference || rawOrder?.shipping_reference || rawOrder?.poNumber || rawOrder?.po_number || externalOrderId),
        payload: {
            accountName,
            poNumber: normalizeFreeText(rawOrder?.poNumber || rawOrder?.po_number || externalOrderId),
            shippingReference: normalizeFreeText(rawOrder?.shippingReference || rawOrder?.shipping_reference || externalOrderId),
            contactName: normalizeFreeText(rawOrder?.contactName || rawOrder?.contact_name || shipToName),
            contactPhone,
            requestedShipDate,
            orderNotes: normalizeFreeText(rawOrder?.orderNotes || rawOrder?.order_notes || rawOrder?.notes || `Imported from SFTP ${sourceContext.fileName || ""}`),
            shipToName,
            shipToAddress1: normalizeFreeText(rawOrder?.shipToAddress1 || rawOrder?.ship_to_address1 || shipTo?.address1 || shipTo?.line1 || ""),
            shipToAddress2: normalizeFreeText(rawOrder?.shipToAddress2 || rawOrder?.ship_to_address2 || shipTo?.address2 || shipTo?.line2 || ""),
            shipToCity: normalizeFreeText(rawOrder?.shipToCity || rawOrder?.ship_to_city || shipTo?.city || ""),
            shipToState: normalizeFreeText(rawOrder?.shipToState || rawOrder?.ship_to_state || shipTo?.state || shipTo?.province || ""),
            shipToPostalCode: normalizeFreeText(rawOrder?.shipToPostalCode || rawOrder?.ship_to_postal_code || shipTo?.postalCode || shipTo?.postal_code || shipTo?.zip || ""),
            shipToCountry: normalizeFreeText(rawOrder?.shipToCountry || rawOrder?.ship_to_country || shipTo?.country || "USA"),
            shipToPhone: normalizeFreeText(rawOrder?.shipToPhone || rawOrder?.ship_to_phone || shipTo?.phone || contactPhone),
            lines
        }
    };
}

function mapSftpInboundToPortalDraft(accountName, rawInbound, sourceContext = {}) {
    const externalInboundId = getSftpExternalId(
        rawInbound?.externalInboundId
        || rawInbound?.external_inbound_id
        || rawInbound?.externalId
        || rawInbound?.inboundId
        || rawInbound?.inbound_id
        || rawInbound?.referenceNumber
        || rawInbound?.reference_number
        || rawInbound?.id,
        `${sourceContext.fileName || "purchase-order"}-${sourceContext.index || 1}`
    );
    const lines = (Array.isArray(rawInbound?.lines) ? rawInbound.lines : (Array.isArray(rawInbound?.items) ? rawInbound.items : []))
        .map((line) => ({
            sku: normalizeText(line?.sku || line?.itemSku || line?.item_sku || line?.code || ""),
            quantity: toPositiveInt(line?.quantity || line?.qty || line?.expectedQuantity || line?.expected_quantity)
        }))
        .filter((line) => line.sku && line.quantity);

    if (!externalInboundId) {
        throw httpError(400, `${sourceContext.fileName || "SFTP purchase order"} is missing an external purchase order id.`);
    }
    if (!lines.length) {
        throw httpError(400, `${externalInboundId} does not contain any purchase order lines.`);
    }

    return {
        externalInboundId,
        label: normalizeFreeText(rawInbound?.referenceNumber || rawInbound?.reference_number || externalInboundId),
        payload: {
            accountName,
            referenceNumber: normalizeFreeText(rawInbound?.referenceNumber || rawInbound?.reference_number || externalInboundId),
            carrierName: normalizeFreeText(rawInbound?.carrierName || rawInbound?.carrier_name || rawInbound?.carrier || ""),
            expectedDate: normalizeDateInput(rawInbound?.expectedDate || rawInbound?.expected_date || rawInbound?.arrivalDate || rawInbound?.arrival_date || new Date()),
            contactName: normalizeFreeText(rawInbound?.contactName || rawInbound?.contact_name || "SFTP Import"),
            contactPhone: normalizeFreeText(rawInbound?.contactPhone || rawInbound?.contact_phone || rawInbound?.phone || ""),
            notes: normalizeFreeText(rawInbound?.notes || rawInbound?.note || `Imported from SFTP ${sourceContext.fileName || ""}`),
            lines
        }
    };
}

async function importSftpOrdersForIntegration(client, integrationRow, mappedOrders, appUser = null) {
    const externalIds = mappedOrders.map((entry) => entry.externalOrderId).filter(Boolean);
    const existingImports = externalIds.length
        ? await client.query(
            "select external_order_id from store_order_imports where integration_id = $1 and external_order_id = any($2::text[])",
            [integrationRow.id, externalIds]
        )
        : { rows: [] };
    const existingIds = new Set(existingImports.rows.map((row) => row.external_order_id));

    let discoveredCount = mappedOrders.length;
    let importedCount = 0;
    let releasedCount = 0;
    let draftCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const detailMessages = [];

    for (const entry of mappedOrders) {
        if (!entry.externalOrderId) {
            failedCount += 1;
            detailMessages.push("Skipped an SFTP order without an external id.");
            continue;
        }
        if (existingIds.has(entry.externalOrderId)) {
            skippedCount += 1;
            continue;
        }

        try {
            let importedOrder = await savePortalOrderDraftForAccount(
                client,
                integrationRow.account_name,
                entry.payload,
                null,
                {
                    portalAccessId: null,
                    downloadPathPrefix: "/api/admin/portal-order-documents",
                    activityTitlePrefix: "sftp order import",
                    activityActor: `${describeStoreIntegrationProvider(integrationRow.provider)} ${integrationRow.integration_name || integrationRow.store_identifier}`,
                    enforceInventoryAvailability: false
                }
            );

            if ((integrationRow.import_status || "DRAFT") === "RELEASED") {
                try {
                    importedOrder = await releaseWarehousePortalOrder(client, importedOrder.id, appUser);
                    releasedCount += 1;
                } catch (error) {
                    draftCount += 1;
                    detailMessages.push(`${entry.label || entry.externalOrderId} imported as draft: ${error.message}`);
                }
            } else {
                draftCount += 1;
            }

            await client.query(
                `
                    insert into store_order_imports (integration_id, external_order_id, portal_order_id)
                    values ($1, $2, $3)
                `,
                [integrationRow.id, entry.externalOrderId, importedOrder.id]
            );
            importedCount += 1;
        } catch (error) {
            failedCount += 1;
            detailMessages.push(`${entry.label || entry.externalOrderId}: ${error.message}`);
        }
    }

    if (existingIds.size > 0) {
        await client.query(
            "update store_order_imports set last_seen_at = now() where integration_id = $1 and external_order_id = any($2::text[])",
            [integrationRow.id, [...existingIds]]
        );
    }

    return { discoveredCount, importedCount, releasedCount, draftCount, skippedCount, failedCount, detailMessages };
}

async function importSftpInboundsForIntegration(client, integrationRow, mappedInbounds) {
    const externalIds = mappedInbounds.map((entry) => entry.externalInboundId).filter(Boolean);
    const existingImports = externalIds.length
        ? await client.query(
            "select external_inbound_id from store_inbound_imports where integration_id = $1 and external_inbound_id = any($2::text[])",
            [integrationRow.id, externalIds]
        )
        : { rows: [] };
    const existingIds = new Set(existingImports.rows.map((row) => row.external_inbound_id));

    let discoveredCount = mappedInbounds.length;
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const detailMessages = [];

    for (const entry of mappedInbounds) {
        if (!entry.externalInboundId) {
            failedCount += 1;
            detailMessages.push("Skipped an SFTP purchase order without an external id.");
            continue;
        }
        if (existingIds.has(entry.externalInboundId)) {
            skippedCount += 1;
            continue;
        }

        try {
            const savedInbound = await savePortalInboundForAccount(
                client,
                integrationRow.account_name,
                entry.payload,
                {
                    portalAccessId: null,
                    activityTitlePrefix: "sftp purchase order import",
                    activityActor: `${describeStoreIntegrationProvider(integrationRow.provider)} ${integrationRow.integration_name || integrationRow.store_identifier}`
                }
            );
            await client.query(
                `
                    insert into store_inbound_imports (integration_id, external_inbound_id, portal_inbound_id)
                    values ($1, $2, $3)
                `,
                [integrationRow.id, entry.externalInboundId, savedInbound.id]
            );
            importedCount += 1;
        } catch (error) {
            failedCount += 1;
            detailMessages.push(`${entry.label || entry.externalInboundId}: ${error.message}`);
        }
    }

    if (existingIds.size > 0) {
        await client.query(
            "update store_inbound_imports set last_seen_at = now() where integration_id = $1 and external_inbound_id = any($2::text[])",
            [integrationRow.id, [...existingIds]]
        );
    }

    return { discoveredCount, importedCount, skippedCount, failedCount, detailMessages };
}

async function archiveSftpImportFile(client, archiveFolder, laneName, remotePath, fileName) {
    const normalizedArchiveFolder = normalizeRemoteFolderPath(archiveFolder);
    if (!normalizedArchiveFolder) return remotePath;
    const laneFolder = joinSftpRemotePath(normalizedArchiveFolder, laneName.toLowerCase());
    await ensureSftpDirectory(client, laneFolder);

    const safeFileName = normalizeUploadFileName(fileName || path.posix.basename(remotePath) || `${laneName.toLowerCase()}.json`) || `${laneName.toLowerCase()}.json`;
    let targetPath = joinSftpRemotePath(laneFolder, safeFileName);
    if (await client.exists(targetPath)) {
        const extension = path.posix.extname(safeFileName);
        const stem = extension ? safeFileName.slice(0, -extension.length) : safeFileName;
        targetPath = joinSftpRemotePath(laneFolder, `${stem}-${Date.now()}${extension || ".json"}`);
    }
    await client.rename(remotePath, targetPath);
    return targetPath;
}

async function syncSftpOrderImports(sftpClient, integrationRow, settings, appUser = null) {
    const summary = { filesFound: 0, discoveredCount: 0, importedCount: 0, releasedCount: 0, draftCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    const files = await listSftpJsonFiles(sftpClient, settings.ordersFolder);
    summary.filesFound = files.length;

    for (const file of files) {
        try {
            const payload = await readSftpJsonFile(sftpClient, file.path);
            const entries = extractSftpPayloadEntries(payload, "orders", file.name)
                .map((entry, entryIndex) => mapSftpOrderToPortalDraft(integrationRow.account_name, entry, {
                    fileName: file.name,
                    index: entryIndex + 1
                }));
            const result = await withTransaction((client) => importSftpOrdersForIntegration(client, integrationRow, entries, appUser));
            summary.discoveredCount += result.discoveredCount;
            summary.importedCount += result.importedCount;
            summary.releasedCount += result.releasedCount;
            summary.draftCount += result.draftCount;
            summary.skippedCount += result.skippedCount;
            summary.failedCount += result.failedCount;
            summary.detailMessages.push(...result.detailMessages);
            await archiveSftpImportFile(sftpClient, settings.archiveFolder, "orders", file.path, file.name);
        } catch (error) {
            summary.failedCount += 1;
            summary.detailMessages.push(`${file.name}: ${error.message}`);
        }
    }

    return summary;
}

async function syncSftpInboundImports(sftpClient, integrationRow, settings) {
    const summary = { filesFound: 0, discoveredCount: 0, importedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    const files = await listSftpJsonFiles(sftpClient, settings.inboundsFolder);
    summary.filesFound = files.length;

    for (const file of files) {
        try {
            const payload = await readSftpJsonFile(sftpClient, file.path);
            const entries = extractSftpPayloadEntries(payload, "inbounds", file.name)
                .map((entry, entryIndex) => mapSftpInboundToPortalDraft(integrationRow.account_name, entry, {
                    fileName: file.name,
                    index: entryIndex + 1
                }));
            const result = await withTransaction((client) => importSftpInboundsForIntegration(client, integrationRow, entries));
            summary.discoveredCount += result.discoveredCount;
            summary.importedCount += result.importedCount;
            summary.skippedCount += result.skippedCount;
            summary.failedCount += result.failedCount;
            summary.detailMessages.push(...result.detailMessages);
            await archiveSftpImportFile(sftpClient, settings.archiveFolder, "inbounds", file.path, file.name);
        } catch (error) {
            summary.failedCount += 1;
            summary.detailMessages.push(`${file.name}: ${error.message}`);
        }
    }

    return summary;
}

function computeStoreSyncContentHash(payload) {
    const stableText = JSON.stringify(payload, (key, value) => key === "exportedAt" ? undefined : value);
    return crypto.createHash("sha256").update(stableText || "").digest("hex");
}

async function hasStoreSyncExport(client, integrationId, entityType, entityRef, contentHash) {
    const result = await client.query(
        `
            select 1
            from store_sync_exports
            where integration_id = $1
              and entity_type = $2
              and entity_ref = $3
              and content_hash = $4
            limit 1
        `,
        [integrationId, entityType, entityRef, contentHash]
    );
    return result.rowCount === 1;
}

async function recordStoreSyncExport(client, integrationId, entityType, entityRef, contentHash, remotePath) {
    await client.query(
        `
            insert into store_sync_exports (integration_id, entity_type, entity_ref, content_hash, remote_path)
            values ($1, $2, $3, $4, $5)
            on conflict (integration_id, entity_type, entity_ref, content_hash)
            do nothing
        `,
        [integrationId, entityType, entityRef, contentHash, remotePath]
    );
}

function buildSftpExportFileName(prefix, reference, contentHash) {
    const safePrefix = sanitizeFilenameSegment(prefix, "sync");
    const safeReference = sanitizeFilenameSegment(reference, "record");
    return `${safePrefix}-${safeReference}-${String(contentHash || "").slice(0, 12)}.json`;
}

function buildSftpShipmentConfirmationPayload(order, externalOrderId = "") {
    return {
        messageType: "SHIPMENT_CONFIRMATION",
        exportedAt: new Date().toISOString(),
        externalOrderId: externalOrderId || "",
        orderCode: order.orderCode,
        accountName: order.accountName,
        status: order.status,
        poNumber: order.poNumber || "",
        shippingReference: order.shippingReference || "",
        requestedShipDate: order.requestedShipDate || "",
        confirmedShipDate: order.confirmedShipDate || "",
        shippedCarrierName: order.shippedCarrierName || "",
        shippedTrackingReference: order.shippedTrackingReference || "",
        shippedConfirmationNote: order.shippedConfirmationNote || "",
        shipTo: {
            name: order.shipToName || "",
            phone: order.shipToPhone || "",
            address1: order.shipToAddress1 || "",
            address2: order.shipToAddress2 || "",
            city: order.shipToCity || "",
            state: order.shipToState || "",
            postalCode: order.shipToPostalCode || "",
            country: order.shipToCountry || ""
        },
        lines: order.lines.map((line) => ({
            lineNumber: Number(line.lineNumber || 0) || 0,
            sku: line.sku,
            upc: line.upc || "",
            description: line.description || "",
            quantity: Number(line.quantity) || 0,
            trackingLevel: line.trackingLevel || "UNIT",
            allocations: Array.isArray(line.pickLocations)
                ? line.pickLocations.map((entry) => ({
                    location: entry.location || "",
                    quantity: Number(entry.quantity) || 0,
                    lotNumber: entry.lotNumber || "",
                    expirationDate: entry.expirationDate || ""
                }))
                : []
        })),
        documents: Array.isArray(order.documents)
            ? order.documents.map((document) => ({
                fileName: document.fileName || "",
                fileType: document.fileType || "",
                fileSize: Number(document.fileSize) || 0
            }))
            : []
    };
}

function buildSftpReceiptConfirmationPayload(inbound, externalInboundId = "") {
    return {
        messageType: "RECEIPT_CONFIRMATION",
        exportedAt: new Date().toISOString(),
        externalInboundId: externalInboundId || "",
        inboundCode: inbound.inboundCode || "",
        accountName: inbound.accountName || "",
        status: inbound.status || "SUBMITTED",
        referenceNumber: inbound.referenceNumber || "",
        carrierName: inbound.carrierName || "",
        expectedDate: inbound.expectedDate || "",
        receivedAt: inbound.receivedAt || "",
        contactName: inbound.contactName || "",
        contactPhone: inbound.contactPhone || "",
        notes: inbound.notes || "",
        lines: Array.isArray(inbound.lines)
            ? inbound.lines.map((line) => ({
                lineNumber: Number(line.lineNumber || 0) || 0,
                sku: line.sku || "",
                upc: line.upc || "",
                description: line.description || "",
                quantity: Number(line.quantity) || 0,
                trackingLevel: line.trackingLevel || "UNIT"
            }))
            : []
    };
}

async function getPortalInboundById(client, inboundId) {
    const result = await client.query("select * from portal_inbounds where id = $1 limit 1", [inboundId]);
    if (result.rowCount !== 1) {
        return null;
    }
    const inboundRow = result.rows[0];
    const linesResult = await client.query(
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
            where l.inbound_id = $1
            order by l.line_number asc, l.id asc
        `,
        [inboundId]
    );
    return mapPortalInboundRow(inboundRow, linesResult.rows.map(mapPortalInboundLineRow));
}

async function exportSftpShipmentConfirmations(client, sftpClient, integrationRow, settings) {
    const summary = { exportedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    if (!settings.shipmentsFolder) return summary;

    await ensureSftpDirectory(sftpClient, settings.shipmentsFolder);
    const result = await client.query(
        `
            select o.id, i.external_order_id
            from portal_orders o
            join store_order_imports i on i.portal_order_id = o.id
            where i.integration_id = $1
              and o.status = 'SHIPPED'
            order by coalesce(o.shipped_at, o.updated_at) asc, o.id asc
        `,
        [integrationRow.id]
    );

    for (const row of result.rows) {
        try {
            const order = await getPortalOrderById(client, row.id, integrationRow.account_name);
            if (!order) continue;
            const payload = buildSftpShipmentConfirmationPayload(order, row.external_order_id || "");
            const contentHash = computeStoreSyncContentHash(payload);
            const entityRef = String(order.id);
            if (await hasStoreSyncExport(client, integrationRow.id, "SHIPMENT_CONFIRMATION", entityRef, contentHash)) {
                summary.skippedCount += 1;
                continue;
            }

            const remotePath = joinSftpRemotePath(
                settings.shipmentsFolder,
                buildSftpExportFileName("shipment", order.orderCode || row.external_order_id || entityRef, contentHash)
            );
            await sftpClient.put(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), remotePath);
            await recordStoreSyncExport(client, integrationRow.id, "SHIPMENT_CONFIRMATION", entityRef, contentHash, remotePath);
            summary.exportedCount += 1;
        } catch (error) {
            summary.failedCount += 1;
            summary.detailMessages.push(`Shipment ${row.external_order_id || row.id}: ${error.message}`);
        }
    }

    return summary;
}

async function exportSftpReceiptConfirmations(client, sftpClient, integrationRow, settings) {
    const summary = { exportedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    if (!settings.receiptsFolder) return summary;

    await ensureSftpDirectory(sftpClient, settings.receiptsFolder);
    const result = await client.query(
        `
            select i.id, m.external_inbound_id
            from portal_inbounds i
            join store_inbound_imports m on m.portal_inbound_id = i.id
            where m.integration_id = $1
              and i.status = 'RECEIVED'
            order by coalesce(i.received_at, i.updated_at) asc, i.id asc
        `,
        [integrationRow.id]
    );

    for (const row of result.rows) {
        try {
            const inbound = await getPortalInboundById(client, row.id);
            if (!inbound) continue;
            const payload = buildSftpReceiptConfirmationPayload(inbound, row.external_inbound_id || "");
            const contentHash = computeStoreSyncContentHash(payload);
            const entityRef = String(inbound.id);
            if (await hasStoreSyncExport(client, integrationRow.id, "RECEIPT_CONFIRMATION", entityRef, contentHash)) {
                summary.skippedCount += 1;
                continue;
            }

            const remotePath = joinSftpRemotePath(
                settings.receiptsFolder,
                buildSftpExportFileName("receipt", inbound.inboundCode || row.external_inbound_id || entityRef, contentHash)
            );
            await sftpClient.put(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), remotePath);
            await recordStoreSyncExport(client, integrationRow.id, "RECEIPT_CONFIRMATION", entityRef, contentHash, remotePath);
            summary.exportedCount += 1;
        } catch (error) {
            summary.failedCount += 1;
            summary.detailMessages.push(`Receipt ${row.external_inbound_id || row.id}: ${error.message}`);
        }
    }

    return summary;
}

async function buildSftpInventorySnapshotPayload(client, accountName) {
    const inventoryResult = await client.query(
        `
            select
                i.*,
                c.description as item_description
            from inventory_lines i
            left join item_catalog c
              on c.account_name = i.account_name
             and c.sku = i.sku
            where i.account_name = $1
            order by i.location asc, i.sku asc, i.lot_number asc, i.expiration_date asc, i.id asc
        `,
        [normalizeText(accountName)]
    );

    return {
        messageType: "INVENTORY_SNAPSHOT",
        exportedAt: new Date().toISOString(),
        accountName: normalizeText(accountName),
        lines: inventoryResult.rows.map((row) => ({
            location: row.location || "",
            sku: row.sku || "",
            upc: row.upc || "",
            description: row.item_description || "",
            trackingLevel: normalizeTrackingLevel(row.tracking_level || "UNIT"),
            quantity: Number(row.quantity) || 0,
            lotNumber: row.lot_number || "",
            expirationDate: normalizeDateOnly(row.expiration_date)
        }))
    };
}

async function exportSftpInventorySnapshot(client, sftpClient, integrationRow, settings) {
    const summary = { exportedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    if (!settings.inventoryFolder) return summary;

    try {
        await ensureSftpDirectory(sftpClient, settings.inventoryFolder);
        const payload = await buildSftpInventorySnapshotPayload(client, integrationRow.account_name);
        const contentHash = computeStoreSyncContentHash(payload);
        const entityRef = normalizeText(integrationRow.account_name);
        if (await hasStoreSyncExport(client, integrationRow.id, "INVENTORY_SNAPSHOT", entityRef, contentHash)) {
            summary.skippedCount += 1;
            return summary;
        }

        const remotePath = joinSftpRemotePath(
            settings.inventoryFolder,
            buildSftpExportFileName("inventory", integrationRow.account_name, contentHash)
        );
        await sftpClient.put(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), remotePath);
        await recordStoreSyncExport(client, integrationRow.id, "INVENTORY_SNAPSHOT", entityRef, contentHash, remotePath);
        summary.exportedCount += 1;
    } catch (error) {
        summary.failedCount += 1;
        summary.detailMessages.push(`Inventory: ${error.message}`);
    }

    return summary;
}

async function syncSftpIntegration(integrationRow, appUser = null) {
    const settings = sanitizeStoreIntegrationSettingsInput(integrationRow.provider, integrationRow.settings || {});
    const sftpClient = await connectSftpForIntegration(integrationRow);
    const orderSummary = { filesFound: 0, discoveredCount: 0, importedCount: 0, releasedCount: 0, draftCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    const inboundSummary = { filesFound: 0, discoveredCount: 0, importedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    const shipmentSummary = { exportedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    const receiptSummary = { exportedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };
    const inventorySummary = { exportedCount: 0, skippedCount: 0, failedCount: 0, detailMessages: [] };

    try {
        if (settings.ordersFolder) {
            Object.assign(orderSummary, await syncSftpOrderImports(sftpClient, integrationRow, settings, appUser));
        }
        if (settings.inboundsFolder) {
            Object.assign(inboundSummary, await syncSftpInboundImports(sftpClient, integrationRow, settings));
        }
        if (settings.shipmentsFolder) {
            Object.assign(shipmentSummary, await exportSftpShipmentConfirmations(pool, sftpClient, integrationRow, settings));
        }
        if (settings.receiptsFolder) {
            Object.assign(receiptSummary, await exportSftpReceiptConfirmations(pool, sftpClient, integrationRow, settings));
        }
        if (settings.inventoryFolder) {
            Object.assign(inventorySummary, await exportSftpInventorySnapshot(pool, sftpClient, integrationRow, settings));
        }
    } finally {
        try {
            await sftpClient.end();
        } catch (_error) {
            // Ignore connection shutdown noise.
        }
    }

    const failedCount = orderSummary.failedCount
        + inboundSummary.failedCount
        + shipmentSummary.failedCount
        + receiptSummary.failedCount
        + inventorySummary.failedCount;
    const meaningfulProgress = orderSummary.importedCount
        + orderSummary.skippedCount
        + inboundSummary.importedCount
        + inboundSummary.skippedCount
        + shipmentSummary.exportedCount
        + shipmentSummary.skippedCount
        + receiptSummary.exportedCount
        + receiptSummary.skippedCount
        + inventorySummary.exportedCount
        + inventorySummary.skippedCount;
    const status = failedCount > 0
        ? (meaningfulProgress > 0 ? "WARNING" : "ERROR")
        : "SUCCESS";

    const baseMessage = [
        `Order files ${orderSummary.filesFound}`,
        `Orders ${orderSummary.importedCount} imported`,
        `Purchase Orders ${inboundSummary.importedCount} imported`,
        `Shipments ${shipmentSummary.exportedCount} exported`,
        `Receipts ${receiptSummary.exportedCount} exported`,
        `Inventory ${inventorySummary.exportedCount} exported`,
        `Failed ${failedCount}`
    ].join(". ") + ".";
    const detailMessages = [
        ...orderSummary.detailMessages,
        ...inboundSummary.detailMessages,
        ...shipmentSummary.detailMessages,
        ...receiptSummary.detailMessages,
        ...inventorySummary.detailMessages
    ];
    const summaryMessage = detailMessages.length
        ? `${baseMessage} ${truncateStoreSyncMessage(detailMessages.slice(0, 4).join(" | "), 380)}`
        : baseMessage;

    const updatedResult = await pool.query(
        `
            update store_integrations
            set
                last_synced_at = now(),
                last_sync_status = $2,
                last_sync_message = $3,
                next_scheduled_sync_at = $4,
                updated_at = now()
            where id = $1
            returning *
        `,
        [
            integrationRow.id,
            status,
            truncateStoreSyncMessage(summaryMessage),
            computeNextStoreIntegrationSyncAt(integrationRow.sync_schedule, { lastSyncedAt: new Date() })
        ]
    );

    await withTransaction(async (client) => {
        await insertActivity(
            client,
            "setup",
            `Synced ${describeStoreIntegrationProvider(integrationRow.provider)} files for ${integrationRow.account_name}`,
            [
                integrationRow.store_identifier || "No host saved",
                `Orders ${orderSummary.importedCount} imported`,
                `Purchase Orders ${inboundSummary.importedCount} imported`,
                `Shipments ${shipmentSummary.exportedCount} exported`,
                `Receipts ${receiptSummary.exportedCount} exported`,
                `Inventory ${inventorySummary.exportedCount} exported`,
                `Failed ${failedCount}`
            ].join(" | ")
        );
    });

    return {
        integration: mapStoreIntegrationRow(updatedResult.rows[0]),
        ordersFetched: orderSummary.discoveredCount,
        importedCount: orderSummary.importedCount,
        releasedCount: orderSummary.releasedCount,
        draftCount: orderSummary.draftCount,
        skippedCount: orderSummary.skippedCount + inboundSummary.skippedCount + shipmentSummary.skippedCount + receiptSummary.skippedCount + inventorySummary.skippedCount,
        failedCount,
        inboundsFetched: inboundSummary.discoveredCount,
        importedInboundCount: inboundSummary.importedCount,
        shippedExportCount: shipmentSummary.exportedCount,
        receiptExportCount: receiptSummary.exportedCount,
        inventoryExportCount: inventorySummary.exportedCount,
        message: truncateStoreSyncMessage(summaryMessage)
    };
}

async function getPortalAccessByAccountName(client, accountName) {
    const normalizedAccount = normalizeText(accountName);
    if (!normalizedAccount) return null;
    const result = await client.query(
        `
            select
                a.*,
                o.feature_flags,
                o.feature_flags_updated_at,
                o.feature_flags_updated_by
            from portal_vendor_access a
            left join owner_accounts o on o.name = a.account_name
            where a.account_name = $1
            limit 1
        `,
        [normalizedAccount]
    );
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function getPortalAccessById(client, accessId) {
    const result = await client.query(
        `
            select
                a.*,
                o.feature_flags,
                o.feature_flags_updated_at,
                o.feature_flags_updated_by
            from portal_vendor_access a
            left join owner_accounts o on o.name = a.account_name
            where a.id = $1
            limit 1
        `,
        [accessId]
    );
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function getPortalAccessByEmail(client, email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    const result = await client.query(
        `
            select
                a.*,
                o.feature_flags,
                o.feature_flags_updated_at,
                o.feature_flags_updated_by
            from portal_vendor_access a
            left join owner_accounts o on o.name = a.account_name
            where a.email = $1
            limit 1
        `,
        [normalizedEmail]
    );
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
                a.*,
                o.feature_flags,
                o.feature_flags_updated_at,
                o.feature_flags_updated_by
            from portal_sessions s
            join portal_vendor_access a on a.id = s.portal_access_id
            left join owner_accounts o on o.name = a.account_name
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

function buildPortalInventoryExportCsv(items) {
    const rows = [
        ["SKU", "UPC", "Description", "Tracking", "On Hand Qty", "Reserved Qty", "Available Qty", "Location Count", "Locations"]
    ].concat(
        items.map((item) => [
            item.sku || "",
            item.upc || "",
            item.description || "",
            normalizeTrackingLevel(item.trackingLevel || item.tracking_level),
            Number(item.onHandQuantity ?? item.on_hand_quantity ?? item.totalQuantity ?? item.total_quantity) || 0,
            Number(item.reservedQuantity ?? item.reserved_quantity) || 0,
            Number(item.availableQuantity ?? item.available_quantity ?? item.totalQuantity ?? item.total_quantity) || 0,
            Number(item.locationCount ?? item.location_count) || 0,
            Array.isArray(item.locations) ? item.locations.filter(Boolean).join(", ") : ""
        ])
    );
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function buildPortalInventoryExportFilename(accountName) {
    return `wms365-customer-inventory-${sanitizeFilenameSegment(accountName, "account")}-${formatFileTimestamp(new Date())}.csv`;
}

async function getAdminPortalInbounds(client = pool) {
    const inboundResult = await client.query(
        `
            select *
            from portal_inbounds
            order by created_at desc, id desc
            limit 200
        `
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
                lot_number,
                expiration_date,
                coalesce(max(nullif(tracking_level, '')), 'UNIT') as tracking_level,
                sum(quantity)::integer as quantity
            from inventory_lines
            where (account_name, sku) in (
                select *
                from unnest($1::text[], $2::text[])
            )
            group by account_name, sku, location, lot_number, expiration_date
            order by
                account_name asc,
                sku asc,
                case when expiration_date <> '' then 0 else 1 end asc,
                expiration_date asc,
                location asc,
                lot_number asc
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
            trackingLevel: normalizeTrackingLevel(row.tracking_level || summary.trackingLevel || 'UNIT'),
            lotNumber: row.lot_number || "",
            expirationDate: normalizeDateOnly(row.expiration_date)
        });
    });

    byKey.forEach((value, key) => summaries.set(key, value));
    return summaries;
}

async function buildPortalOrderAllocationSummaries(client, lineRows = []) {
    const lineIds = [...new Set(lineRows.map((row) => Number(row.id) || 0).filter((value) => value > 0))];
    const summaries = new Map();
    if (!lineIds.length) return summaries;

    const result = await client.query(
        `
            select *
            from portal_order_allocations
            where order_line_id = any($1::bigint[])
            order by
                order_line_id asc,
                case when expiration_date <> '' then 0 else 1 end asc,
                expiration_date asc,
                location asc,
                lot_number asc,
                id asc
        `,
        [lineIds]
    );

    result.rows.forEach((row) => {
        const key = String(row.order_line_id);
        if (!summaries.has(key)) {
            summaries.set(key, {
                allocatedQuantity: 0,
                locations: []
            });
        }
        const summary = summaries.get(key);
        const quantity = Number(row.allocated_quantity) || 0;
        summary.allocatedQuantity += quantity;
        summary.locations.push({
            inventoryLineId: row.inventory_line_id ? String(row.inventory_line_id) : "",
            location: row.location || "",
            quantity,
            trackingLevel: normalizeTrackingLevel(row.tracking_level || "UNIT"),
            lotNumber: row.lot_number || "",
            expirationDate: normalizeDateOnly(row.expiration_date)
        });
    });

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
                    c.tracking_level as item_tracking_level,
                    c.lot_tracked as item_lot_tracked,
                    c.expiration_tracked as item_expiration_tracked
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
    const allocationSummaries = await buildPortalOrderAllocationSummaries(client, linesResult.rows);
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

    return mapPortalOrders(ordersResult.rows, linesResult.rows, documentsResult.rows, "/api/portal/order-documents", locationSummaries, allocationSummaries);
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
                    c.tracking_level as item_tracking_level,
                    c.lot_tracked as item_lot_tracked,
                    c.expiration_tracked as item_expiration_tracked
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
    const allocationSummaries = await buildPortalOrderAllocationSummaries(client, linesResult.rows);
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

    return mapPortalOrders(ordersResult.rows, linesResult.rows, documentsResult.rows, "/api/admin/portal-order-documents", locationSummaries, allocationSummaries);
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
                c.tracking_level as item_tracking_level,
                c.lot_tracked as item_lot_tracked,
                c.expiration_tracked as item_expiration_tracked
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
    const allocationSummaries = await buildPortalOrderAllocationSummaries(client, linesResult.rows);
    const locationSummaries = await buildPortalOrderLocationSummaries(client, linesResult.rows);

    return mapPortalOrders(orderResult.rows, linesResult.rows, documentsResult.rows, downloadPathPrefix, locationSummaries, allocationSummaries)[0] || null;
}

async function savePortalOrderDraftForAccount(
    client,
    accountName,
    rawOrder,
    orderId = null,
    {
        portalAccessId = null,
        downloadPathPrefix = "/api/admin/portal-order-documents",
        activityTitlePrefix = "portal",
        activityActor = "",
        enforceInventoryAvailability = true
    } = {}
) {
    const normalizedAccount = normalizeText(accountName);
    const order = sanitizePortalOrderInput(rawOrder, normalizedAccount);

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

    if (enforceInventoryAvailability) {
        for (const line of order.lines) {
            await assertPortalOrderSkuAllowed(client, normalizedAccount, line.sku, line.quantity);
        }
    }

    let savedOrderId = orderId;
    if (savedOrderId) {
        const existing = await getPortalOrderById(client, savedOrderId, normalizedAccount, downloadPathPrefix);
        if (!existing) {
            throw httpError(404, "That draft order could not be found.");
        }
        if (existing.status !== "DRAFT") {
            throw httpError(400, "Released orders can no longer be edited.");
        }

        await client.query(
            `
                update portal_orders
                set
                    portal_access_id = $16,
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
                order.shipToPhone,
                portalAccessId
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
                normalizedAccount,
                portalAccessId,
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

    const savedOrder = await getPortalOrderById(client, savedOrderId, normalizedAccount, downloadPathPrefix);
    await insertActivity(
        client,
        "order",
        `${orderId ? "Updated" : "Created"} ${activityTitlePrefix} order ${savedOrder.orderCode}`,
        [
            savedOrder.accountName,
            `${formatCount(savedOrder.lines.length, "line")}`,
            `PO ${savedOrder.poNumber}`,
            `Requested ${savedOrder.requestedShipDate || "No ship date"}`,
            activityActor || ""
        ].filter(Boolean).join(" | ")
    );
    return savedOrder;
}

async function savePortalOrderDraft(client, accessRow, rawOrder, orderId = null) {
    const access = mapPortalAccessRow(accessRow);
    return savePortalOrderDraftForAccount(client, access.accountName, rawOrder, orderId, {
        portalAccessId: accessRow.id,
        downloadPathPrefix: "/api/portal/order-documents",
        activityTitlePrefix: "portal",
        activityActor: "Company portal"
    });
}

function sortInventoryRowsForAllocation(rows = [], { expirationTracked = false } = {}) {
    return [...rows].sort((left, right) => {
        const leftExpiration = normalizeDateOnly(left.expiration_date || left.expirationDate);
        const rightExpiration = normalizeDateOnly(right.expiration_date || right.expirationDate);
        if (expirationTracked || leftExpiration || rightExpiration) {
            const leftHasExpiration = leftExpiration ? 0 : 1;
            const rightHasExpiration = rightExpiration ? 0 : 1;
            if (leftHasExpiration !== rightHasExpiration) return leftHasExpiration - rightHasExpiration;
            if (leftExpiration !== rightExpiration) return String(leftExpiration).localeCompare(String(rightExpiration));
        }

        const leftCreated = left.created_at ? new Date(left.created_at).getTime() : 0;
        const rightCreated = right.created_at ? new Date(right.created_at).getTime() : 0;
        if (leftCreated !== rightCreated) return leftCreated - rightCreated;

        const leftUpdated = left.updated_at ? new Date(left.updated_at).getTime() : 0;
        const rightUpdated = right.updated_at ? new Date(right.updated_at).getTime() : 0;
        if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;

        const locationCompare = String(left.location || "").localeCompare(String(right.location || ""));
        if (locationCompare !== 0) return locationCompare;

        const lotCompare = String(left.lot_number || left.lotNumber || "").localeCompare(String(right.lot_number || right.lotNumber || ""));
        if (lotCompare !== 0) return lotCompare;

        return (Number(left.id) || 0) - (Number(right.id) || 0);
    });
}

async function allocatePortalOrderInventory(client, order) {
    const normalizedAccount = normalizeText(order.accountName);
    const lineIds = order.lines.map((line) => Number(line.id) || 0).filter((value) => value > 0);
    if (!lineIds.length) {
        throw httpError(400, "Order lines could not be allocated because the saved lines were not found.");
    }

    const skus = [...new Set(order.lines.map((line) => normalizeText(line.sku)).filter(Boolean))];
    const inventoryResult = skus.length
        ? await client.query(
            `
                select
                    i.*,
                    c.lot_tracked as item_lot_tracked,
                    c.expiration_tracked as item_expiration_tracked
                from inventory_lines i
                left join item_catalog c
                  on c.account_name = i.account_name
                 and c.sku = i.sku
                where i.account_name = $1
                  and i.sku = any($2::text[])
                order by i.sku asc, i.location asc, i.id asc
            `,
            [normalizedAccount, skus]
        )
        : { rows: [] };

    const requestedReservations = skus.length
        ? await client.query(
            `
                select
                    l.sku,
                    coalesce(sum(l.requested_quantity), 0)::integer as requested_quantity
                from portal_orders o
                join portal_order_lines l on l.order_id = o.id
                where o.account_name = $1
                  and o.status = any($2::text[])
                  and o.id <> $3
                  and l.sku = any($4::text[])
                group by l.sku
            `,
            [normalizedAccount, ACTIVE_PORTAL_ORDER_STATUSES, order.id, skus]
        )
        : { rows: [] };

    const allocatedReservations = skus.length
        ? await client.query(
            `
                select
                    a.sku,
                    coalesce(sum(a.allocated_quantity), 0)::integer as allocated_quantity
                from portal_orders o
                join portal_order_allocations a on a.order_id = o.id
                where o.account_name = $1
                  and o.status = any($2::text[])
                  and o.id <> $3
                  and a.sku = any($4::text[])
                group by a.sku
            `,
            [normalizedAccount, ACTIVE_PORTAL_ORDER_STATUSES, order.id, skus]
        )
        : { rows: [] };

    const allocatedByInventoryLine = skus.length
        ? await client.query(
            `
                select
                    a.inventory_line_id,
                    coalesce(sum(a.allocated_quantity), 0)::integer as allocated_quantity
                from portal_orders o
                join portal_order_allocations a on a.order_id = o.id
                where o.account_name = $1
                  and o.status = any($2::text[])
                  and o.id <> $3
                  and a.sku = any($4::text[])
                  and a.inventory_line_id is not null
                group by a.inventory_line_id
            `,
            [normalizedAccount, ACTIVE_PORTAL_ORDER_STATUSES, order.id, skus]
        )
        : { rows: [] };

    const requestedBySku = new Map(requestedReservations.rows.map((row) => [normalizeText(row.sku), Number(row.requested_quantity) || 0]));
    const allocatedBySku = new Map(allocatedReservations.rows.map((row) => [normalizeText(row.sku), Number(row.allocated_quantity) || 0]));
    const allocatedByInventoryLineMap = new Map(allocatedByInventoryLine.rows.map((row) => [String(row.inventory_line_id), Number(row.allocated_quantity) || 0]));
    const inventoryBySku = new Map();

    inventoryResult.rows.forEach((row) => {
        const sku = normalizeText(row.sku);
        if (!inventoryBySku.has(sku)) {
            inventoryBySku.set(sku, []);
        }
        inventoryBySku.get(sku).push({
            ...row,
            availableQuantity: Math.max(0, (Number(row.quantity) || 0) - (allocatedByInventoryLineMap.get(String(row.id)) || 0))
        });
    });

    for (const [sku, rows] of inventoryBySku.entries()) {
        let remainingLegacyReserve = Math.max(0, (requestedBySku.get(sku) || 0) - (allocatedBySku.get(sku) || 0));
        if (remainingLegacyReserve <= 0) continue;
        const sortedRows = sortInventoryRowsForAllocation(rows, { expirationTracked: rows.some((row) => row.item_expiration_tracked === true || normalizeDateOnly(row.expiration_date)) });
        for (const row of sortedRows) {
            if (remainingLegacyReserve <= 0) break;
            const deduction = Math.min(Number(row.availableQuantity) || 0, remainingLegacyReserve);
            row.availableQuantity = Math.max(0, (Number(row.availableQuantity) || 0) - deduction);
            remainingLegacyReserve -= deduction;
        }
    }

    const allocations = [];

    for (const line of order.lines) {
        let remainingQuantity = Number(line.quantity) || 0;
        if (remainingQuantity <= 0) continue;

        const sku = normalizeText(line.sku);
        const allRows = inventoryBySku.get(sku) || [];
        const candidateRows = sortInventoryRowsForAllocation(
            allRows.filter((row) =>
                (!line.lotTracked || !!String(row.lot_number || "").trim()) &&
                (!line.expirationTracked || !!normalizeDateOnly(row.expiration_date))
            ),
            line
        );
        const allocatableQuantity = candidateRows.reduce((sum, row) => sum + (Number(row.availableQuantity) || 0), 0);
        if (allocatableQuantity < remainingQuantity) {
            throw httpError(
                409,
                `Release blocked for ${order.orderCode}: ${line.sku} only has ${formatTrackedQuantity(allocatableQuantity, line.trackingLevel)} allocatable with the required lot and expiration data.`
            );
        }

        for (const row of candidateRows) {
            if (remainingQuantity <= 0) break;
            const rowAvailable = Number(row.availableQuantity) || 0;
            if (rowAvailable <= 0) continue;
            const allocatedQuantity = Math.min(rowAvailable, remainingQuantity);
            row.availableQuantity = rowAvailable - allocatedQuantity;
            remainingQuantity -= allocatedQuantity;
            allocations.push({
                orderId: String(order.id),
                orderLineId: String(line.id),
                inventoryLineId: String(row.id),
                sku,
                location: row.location || "",
                lotNumber: row.lot_number || "",
                expirationDate: normalizeDateOnly(row.expiration_date),
                trackingLevel: normalizeTrackingLevel(row.tracking_level || line.trackingLevel || "UNIT"),
                quantity: allocatedQuantity
            });
        }
    }

    await client.query("delete from portal_order_allocations where order_id = $1", [order.id]);
    for (const allocation of allocations) {
        await client.query(
            `
                insert into portal_order_allocations (
                    order_id, order_line_id, inventory_line_id, sku, location, lot_number,
                    expiration_date, tracking_level, allocated_quantity
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `,
            [
                allocation.orderId,
                allocation.orderLineId,
                allocation.inventoryLineId,
                allocation.sku,
                allocation.location,
                allocation.lotNumber || "",
                allocation.expirationDate || "",
                allocation.trackingLevel || "UNIT",
                allocation.quantity
            ]
        );
    }
}

async function releasePortalOrderForAccount(
    client,
    accountName,
    orderId,
    {
        downloadPathPrefix = "/api/admin/portal-order-documents",
        activityTitlePrefix = "portal",
        activityActor = ""
    } = {}
) {
    const normalizedAccount = normalizeText(accountName);
    const order = await getPortalOrderById(client, orderId, normalizedAccount, downloadPathPrefix);
    if (!order) {
        throw httpError(404, "That order could not be found.");
    }
    if (order.status === "RELEASED") {
        return order;
    }
    if (order.status !== "DRAFT") {
        throw httpError(400, `Orders already marked ${order.status} cannot be released again.`);
    }
    if (!order.lines.length) {
        throw httpError(400, "Add at least one line before releasing the order.");
    }

    for (const line of order.lines) {
        await assertPortalOrderSkuAllowed(client, normalizedAccount, line.sku, line.quantity);
    }

    await allocatePortalOrderInventory(client, order);

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

    const releasedOrder = await getPortalOrderById(client, orderId, normalizedAccount, downloadPathPrefix);
    await insertActivity(
        client,
        "order",
        `Released ${activityTitlePrefix} order ${releasedOrder.orderCode}`,
        [
            releasedOrder.accountName,
            `${formatCount(releasedOrder.lines.length, "line")}`,
            releasedOrder.shippingReference || "No shipping reference",
            activityActor || ""
        ].filter(Boolean).join(" | ")
    );
    return releasedOrder;
}

async function releasePortalOrder(client, accessRow, orderId) {
    const access = mapPortalAccessRow(accessRow);
    return releasePortalOrderForAccount(client, access.accountName, orderId, {
        downloadPathPrefix: "/api/portal/order-documents",
        activityTitlePrefix: "portal",
        activityActor: "Company portal"
    });
}

async function saveWarehousePortalOrderDraft(client, accountName, rawOrder, orderId = null, appUser = null) {
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    await upsertOwnerMaster(client, accountName);
    return savePortalOrderDraftForAccount(client, accountName, rawOrder, orderId, {
        portalAccessId: null,
        downloadPathPrefix: "/api/admin/portal-order-documents",
        activityTitlePrefix: "warehouse sales",
        activityActor: actor
    });
}

async function releaseWarehousePortalOrder(client, orderId, appUser = null) {
    const orderResult = await client.query("select account_name from portal_orders where id = $1 limit 1", [orderId]);
    if (orderResult.rowCount !== 1) {
        throw httpError(404, "That order could not be found.");
    }
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    return releasePortalOrderForAccount(client, orderResult.rows[0].account_name, orderId, {
        downloadPathPrefix: "/api/admin/portal-order-documents",
        activityTitlePrefix: "warehouse sales",
        activityActor: actor
    });
}

async function savePortalCatalogItemForAccount(
    client,
    accountName,
    rawItem,
    originalSku = "",
    {
        activityTitlePrefix = "portal",
        activityActor = ""
    } = {}
) {
    const normalizedAccount = normalizeText(accountName);
    const normalizedOriginalSku = normalizeText(originalSku || rawItem?.originalSku || rawItem?.original_sku || "");
    const entry = sanitizeItemMasterInput({ ...rawItem, accountName: normalizedAccount });

    if (!entry || !entry.accountName || !entry.sku) {
        throw httpError(400, "Company and SKU are required.");
    }

    const finalEntry = normalizedOriginalSku && normalizedOriginalSku !== entry.sku
        ? await updateItemMasterAndInventory(client, normalizedAccount, normalizedOriginalSku, entry)
        : (await replaceItemMaster(client, entry), entry);

    const savedItem = await findCatalogItem(client, normalizedAccount, finalEntry.sku);
    await insertActivity(
        client,
        "setup",
        `${normalizedOriginalSku && normalizedOriginalSku !== finalEntry.sku ? "Updated" : "Saved"} ${activityTitlePrefix} item ${finalEntry.sku}`,
        [
            normalizedAccount,
            finalEntry.description || "",
            finalEntry.upc ? `UPC ${finalEntry.upc}` : "",
            activityActor || ""
        ].filter(Boolean).join(" | ")
    );
    return savedItem ? mapPortalItemRow(savedItem) : mapPortalItemRow({
        id: "",
        account_name: normalizedAccount,
        sku: finalEntry.sku,
        upc: finalEntry.upc,
        description: finalEntry.description,
        tracking_level: finalEntry.trackingLevel,
        units_per_case: finalEntry.unitsPerCase,
        each_length: finalEntry.eachLength,
        each_width: finalEntry.eachWidth,
        each_height: finalEntry.eachHeight,
        case_length: finalEntry.caseLength,
        case_width: finalEntry.caseWidth,
        case_height: finalEntry.caseHeight,
        image_url: finalEntry.imageUrl,
        lot_tracked: finalEntry.lotTracked,
        expiration_tracked: finalEntry.expirationTracked,
        created_at: finalEntry.createdAt,
        updated_at: finalEntry.updatedAt
    });
}

async function savePortalCatalogItem(client, accessRow, rawItem, originalSku = "") {
    const access = mapPortalAccessRow(accessRow);
    return savePortalCatalogItemForAccount(client, access.accountName, rawItem, originalSku, {
        activityTitlePrefix: "portal",
        activityActor: "Company portal"
    });
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

function hasSystemEmailConfig() {
    return !!SMTP_HOST && !!SMTP_PORT && !!SMTP_FROM;
}

function getSystemMailer(configErrorMessage = "System email is not configured. Set SMTP_HOST, SMTP_PORT, and SMTP_FROM first.") {
    if (!hasSystemEmailConfig()) {
        throw httpError(500, configErrorMessage);
    }
    if ((SMTP_USER && !SMTP_PASS) || (!SMTP_USER && SMTP_PASS)) {
        throw httpError(500, "SMTP is partially configured. Set both SMTP_USER and SMTP_PASS, or leave both blank.");
    }
    if (!systemMailer) {
        systemMailer = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
        });
    }
    return systemMailer;
}

function hasShipmentEmailConfig() {
    return hasSystemEmailConfig();
}

function getShipmentMailer() {
    return getSystemMailer("Shipment email is not configured. Set SMTP_HOST, SMTP_PORT, and SMTP_FROM before marking an order shipped.");
}

function getDemoRequestRecipients() {
    const recipients = new Set();
    const addRecipient = (value) => {
        const email = normalizeEmail(value);
        if (email && !email.endsWith(".local")) {
            recipients.add(email);
        }
    };
    addRecipient(DEMO_REQUEST_TO);
    addRecipient(SMTP_REPLY_TO);
    addRecipient(DEFAULT_ADMIN_EMAIL);
    return [...recipients];
}

function isValidEmailAddress(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizeEmailList(value, { throwOnInvalid = false } = {}) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[\n\r,;]+/);
    const emails = [];
    const seen = new Set();
    const invalidEntries = [];

    for (const entry of source) {
        const rawValue = String(entry || "").trim();
        if (!rawValue) continue;
        const email = normalizeEmail(rawValue);
        if (!isValidEmailAddress(email)) {
            invalidEntries.push(rawValue);
            continue;
        }
        if (email.endsWith(".local") || seen.has(email)) continue;
        seen.add(email);
        emails.push(email);
    }

    if (throwOnInvalid && invalidEntries.length) {
        throw httpError(400, `Enter valid email addresses. Problem entries: ${invalidEntries.join(", ")}`);
    }

    return emails;
}

function sanitizePortalOrderReleaseOptions(raw) {
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const notifyWarehouse = toBooleanFlag(input.notifyWarehouse, false);
    const savePdfCopy = toBooleanFlag(input.savePdfCopy, false);
    const ccEmails = normalizeEmailList(input.ccEmails, { throwOnInvalid: true });

    if (!notifyWarehouse && ccEmails.length) {
        throw httpError(400, "Turn on the warehouse email option before adding CC recipients.");
    }

    return {
        notifyWarehouse,
        ccEmails,
        savePdfCopy
    };
}

function formatDemoRequestSubmittedAt(value) {
    try {
        return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    } catch {
        return value || "";
    }
}

function buildDemoRequestEmailText(request) {
    return [
        `New WMS365 demo request from ${request.companyName}`,
        `Submitted: ${formatDemoRequestSubmittedAt(request.createdAt)}`,
        `Name: ${request.fullName}`,
        `Work Email: ${request.workEmail}`,
        request.phone ? `Phone: ${request.phone}` : "",
        request.roleTitle ? `Role: ${request.roleTitle}` : "",
        request.warehouseCount ? `Warehouse Count: ${request.warehouseCount}` : "",
        request.monthlyOrderVolume ? `Monthly Volume: ${request.monthlyOrderVolume}` : "",
        request.operationsType ? `Operations Type: ${request.operationsType}` : "",
        request.interestSummary ? `Interested In: ${request.interestSummary}` : "",
        request.message ? `Notes: ${request.message}` : "",
        request.sourcePage ? `Source Page: ${request.sourcePage}` : "",
        request.ipAddress ? `IP Address: ${request.ipAddress}` : "",
        request.userAgent ? `User Agent: ${request.userAgent}` : ""
    ].filter(Boolean).join("\n");
}

function buildDemoRequestEmailHtml(request) {
    const rows = [
        ["Submitted", formatDemoRequestSubmittedAt(request.createdAt)],
        ["Name", request.fullName],
        ["Work Email", request.workEmail],
        ["Phone", request.phone],
        ["Role", request.roleTitle],
        ["Warehouse Count", request.warehouseCount],
        ["Monthly Volume", request.monthlyOrderVolume],
        ["Operations Type", request.operationsType],
        ["Interested In", request.interestSummary],
        ["Source Page", request.sourcePage],
        ["IP Address", request.ipAddress],
        ["User Agent", request.userAgent]
    ].filter(([, value]) => value);

    return `
        <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5;">
            <h2 style="margin:0 0 12px;">New WMS365 Demo Request</h2>
            <p style="margin:0 0 16px;">A prospect requested a WMS365 walkthrough.</p>
            <table style="border-collapse:collapse;width:100%;max-width:720px;">
                ${rows.map(([label, value]) => `
                    <tr>
                        <td style="padding:6px 0;font-weight:600;vertical-align:top;width:180px;">${escapeHtml(label)}</td>
                        <td style="padding:6px 0;">${escapeHtml(value)}</td>
                    </tr>
                `).join("")}
            </table>
            ${request.message ? `
                <div style="margin-top:18px;padding:14px 16px;border:1px solid #cbd5e1;border-radius:14px;background:#f8fafc;">
                    <div style="font-weight:600;margin-bottom:8px;">Notes</div>
                    <div>${escapeHtml(request.message)}</div>
                </div>
            ` : ""}
        </div>
    `;
}

async function sendDemoRequestNotification(request) {
    const recipients = getDemoRequestRecipients();
    if (!recipients.length || !hasSystemEmailConfig()) {
        return [];
    }

    const transporter = getSystemMailer();
    await transporter.sendMail({
        from: SMTP_FROM,
        to: recipients.join(", "),
        replyTo: request.workEmail || SMTP_REPLY_TO || undefined,
        subject: `New WMS365 demo request - ${request.companyName}`,
        text: buildDemoRequestEmailText(request),
        html: buildDemoRequestEmailHtml(request)
    });
    return recipients;
}

function formatAdminDigestDateLabel(dateKey) {
    const parsed = new Date(`${dateKey}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime())) {
        return dateKey;
    }
    return new Intl.DateTimeFormat("en-US", {
        timeZone: ADMIN_ACTIVITY_DIGEST_TIME_ZONE,
        dateStyle: "full"
    }).format(parsed);
}

function formatAdminDigestTimestamp(value) {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: ADMIN_ACTIVITY_DIGEST_TIME_ZONE,
            dateStyle: "medium",
            timeStyle: "short"
        }).format(new Date(value));
    } catch {
        return value || "";
    }
}

function formatAdminDigestTime(value) {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: ADMIN_ACTIVITY_DIGEST_TIME_ZONE,
            hour: "numeric",
            minute: "2-digit"
        }).format(new Date(value));
    } catch {
        return "";
    }
}

function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(Number(value) || 0);
}

function coerceInteger(value) {
    return Number.parseInt(String(value ?? "0"), 10) || 0;
}

async function buildAdminActivityDigest(dateKey, { now = new Date() } = {}) {
    const dateValue = dateKey;
    const [ordersResult, inboundsResult, billingResult, feedbackResult, activityCountResult, recentActivityResult, inventoryResult, companyTouchResult] = await Promise.all([
        pool.query(
            `
                select
                    coalesce(sum(case when timezone($1, created_at)::date = $2::date then 1 else 0 end), 0)::integer as created_count,
                    coalesce(sum(case when released_at is not null and timezone($1, released_at)::date = $2::date then 1 else 0 end), 0)::integer as released_count,
                    coalesce(sum(case when picked_at is not null and timezone($1, picked_at)::date = $2::date then 1 else 0 end), 0)::integer as picked_count,
                    coalesce(sum(case when staged_at is not null and timezone($1, staged_at)::date = $2::date then 1 else 0 end), 0)::integer as staged_count,
                    coalesce(sum(case when shipped_at is not null and timezone($1, shipped_at)::date = $2::date then 1 else 0 end), 0)::integer as shipped_count
                from portal_orders
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                select
                    coalesce(sum(case when timezone($1, created_at)::date = $2::date then 1 else 0 end), 0)::integer as created_count,
                    coalesce(sum(case when received_at is not null and timezone($1, received_at)::date = $2::date then 1 else 0 end), 0)::integer as received_count
                from portal_inbounds
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                select
                    count(*)::integer as event_count,
                    coalesce(sum(quantity * unit_amount), 0)::numeric as total_amount,
                    coalesce(sum(case when status = 'OPEN' then quantity * unit_amount else 0 end), 0)::numeric as open_amount
                from billing_events
                where timezone($1, created_at)::date = $2::date
                  and status <> 'VOID'
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                select
                    count(*)::integer as total_count,
                    coalesce(sum(case when request_type = 'BUG' then 1 else 0 end), 0)::integer as bug_count,
                    coalesce(sum(case when request_type = 'FEATURE' then 1 else 0 end), 0)::integer as feature_count,
                    coalesce(sum(case when source = 'WAREHOUSE' then 1 else 0 end), 0)::integer as warehouse_count,
                    coalesce(sum(case when source = 'PORTAL' then 1 else 0 end), 0)::integer as portal_count
                from feedback_submissions
                where timezone($1, created_at)::date = $2::date
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                select count(*)::integer as total_count
                from activity_log
                where timezone($1, created_at)::date = $2::date
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                select type, title, details, created_at
                from activity_log
                where timezone($1, created_at)::date = $2::date
                order by created_at desc
                limit 12
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                select
                    count(*)::integer as lines_added,
                    coalesce(sum(quantity), 0)::integer as quantity_added
                from inventory_lines
                where timezone($1, created_at)::date = $2::date
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        ),
        pool.query(
            `
                with touched as (
                    select account_name
                    from portal_orders
                    where account_name <> ''
                      and (
                        timezone($1, created_at)::date = $2::date
                        or (released_at is not null and timezone($1, released_at)::date = $2::date)
                        or (picked_at is not null and timezone($1, picked_at)::date = $2::date)
                        or (staged_at is not null and timezone($1, staged_at)::date = $2::date)
                        or (shipped_at is not null and timezone($1, shipped_at)::date = $2::date)
                      )
                    union
                    select account_name
                    from portal_inbounds
                    where account_name <> ''
                      and (
                        timezone($1, created_at)::date = $2::date
                        or (received_at is not null and timezone($1, received_at)::date = $2::date)
                      )
                    union
                    select account_name
                    from billing_events
                    where account_name <> ''
                      and timezone($1, created_at)::date = $2::date
                    union
                    select account_name
                    from feedback_submissions
                    where account_name <> ''
                      and timezone($1, created_at)::date = $2::date
                )
                select count(*)::integer as company_count
                from touched
            `,
            [ADMIN_ACTIVITY_DIGEST_TIME_ZONE, dateValue]
        )
    ]);

    const orders = ordersResult.rows[0] || {};
    const inbounds = inboundsResult.rows[0] || {};
    const billing = billingResult.rows[0] || {};
    const feedback = feedbackResult.rows[0] || {};
    const inventory = inventoryResult.rows[0] || {};
    const activityCount = activityCountResult.rows[0] || {};
    const companyTouch = companyTouchResult.rows[0] || {};

    return {
        dateKey,
        dateLabel: formatAdminDigestDateLabel(dateKey),
        generatedAt: now.toISOString(),
        buildLabel: APP_BUILD_INFO.label,
        recipient: ADMIN_ACTIVITY_SUMMARY_TO,
        totals: {
            companiesTouched: coerceInteger(companyTouch.company_count),
            activityCount: coerceInteger(activityCount.total_count),
            orderCreated: coerceInteger(orders.created_count),
            orderReleased: coerceInteger(orders.released_count),
            orderPicked: coerceInteger(orders.picked_count),
            orderStaged: coerceInteger(orders.staged_count),
            orderShipped: coerceInteger(orders.shipped_count),
            inboundCreated: coerceInteger(inbounds.created_count),
            inboundReceived: coerceInteger(inbounds.received_count),
            inventoryLinesAdded: coerceInteger(inventory.lines_added),
            inventoryQuantityAdded: coerceInteger(inventory.quantity_added),
            billingEventCount: coerceInteger(billing.event_count),
            billingTotalAmount: Number(billing.total_amount) || 0,
            billingOpenAmount: Number(billing.open_amount) || 0,
            feedbackTotal: coerceInteger(feedback.total_count),
            feedbackBug: coerceInteger(feedback.bug_count),
            feedbackFeature: coerceInteger(feedback.feature_count),
            feedbackWarehouse: coerceInteger(feedback.warehouse_count),
            feedbackPortal: coerceInteger(feedback.portal_count)
        },
        recentActivity: recentActivityResult.rows.map((row) => ({
            type: row.type || "",
            title: row.title || "",
            details: row.details || "",
            createdAt: row.created_at
        }))
    };
}

function buildAdminActivityDigestText(digest) {
    const totals = digest.totals || {};
    const recentActivityLines = (digest.recentActivity || []).length
        ? digest.recentActivity.map((entry) => {
            const detailText = normalizeFreeText(entry.details || "");
            return `- ${formatAdminDigestTime(entry.createdAt)} | ${entry.title}${detailText ? ` | ${detailText}` : ""}`;
        })
        : ["- No activity was logged today."];

    return [
        "WMS365 Daily Activity Summary",
        `Date: ${digest.dateLabel}`,
        `Generated: ${formatAdminDigestTimestamp(digest.generatedAt)} (${ADMIN_ACTIVITY_DIGEST_TIME_ZONE})`,
        `Build: ${digest.buildLabel}`,
        "",
        "Overview",
        `- Companies touched: ${formatNumber(totals.companiesTouched)}`,
        `- Activity log entries: ${formatNumber(totals.activityCount)}`,
        "",
        "Orders",
        `- Created: ${formatNumber(totals.orderCreated)}`,
        `- Released: ${formatNumber(totals.orderReleased)}`,
        `- Picked: ${formatNumber(totals.orderPicked)}`,
        `- Staged: ${formatNumber(totals.orderStaged)}`,
        `- Shipped: ${formatNumber(totals.orderShipped)}`,
        "",
        "Purchase Orders",
        `- Created: ${formatNumber(totals.inboundCreated)}`,
        `- Received: ${formatNumber(totals.inboundReceived)}`,
        "",
        "Inventory",
        `- Inventory lines added: ${formatNumber(totals.inventoryLinesAdded)}`,
        `- Quantity added: ${formatNumber(totals.inventoryQuantityAdded)}`,
        "",
        "Billing",
        `- New billing events: ${formatNumber(totals.billingEventCount)}`,
        `- Captured amount: ${formatCurrency(totals.billingTotalAmount)}`,
        `- Open amount: ${formatCurrency(totals.billingOpenAmount)}`,
        "",
        "Feedback",
        `- Total submissions: ${formatNumber(totals.feedbackTotal)}`,
        `- Bugs: ${formatNumber(totals.feedbackBug)}`,
        `- Features: ${formatNumber(totals.feedbackFeature)}`,
        `- Warehouse: ${formatNumber(totals.feedbackWarehouse)}`,
        `- Portal: ${formatNumber(totals.feedbackPortal)}`,
        "",
        "Recent Activity",
        ...recentActivityLines
    ].join("\n");
}

async function sendAdminActivityDigestEmail(digest) {
    if (!ADMIN_ACTIVITY_SUMMARY_TO) {
        return;
    }
    const transporter = getSystemMailer("Admin activity email is not configured. Set SMTP_HOST, SMTP_PORT, and SMTP_FROM first.");
    await transporter.sendMail({
        from: SMTP_FROM,
        to: ADMIN_ACTIVITY_SUMMARY_TO,
        replyTo: SMTP_REPLY_TO || undefined,
        subject: `WMS365 daily activity summary - ${digest.dateLabel}`,
        text: buildAdminActivityDigestText(digest)
    });
}

function normalizeStripeResourceId(value, prefix = "") {
    const text = String(
        value && typeof value === "object" && !Array.isArray(value)
            ? value.id || ""
            : value || ""
    ).trim();
    if (!text) return "";
    if (!prefix) return text;
    return text.startsWith(`${prefix}_`) ? text : "";
}

function normalizeStripeCheckoutSessionId(value) {
    return normalizeStripeResourceId(value, "cs");
}

function normalizeStripeCustomerId(value) {
    return normalizeStripeResourceId(value, "cus");
}

function normalizeStripeSubscriptionId(value) {
    return normalizeStripeResourceId(value, "sub");
}

function normalizeStripePriceId(value) {
    return normalizeStripeResourceId(value, "price");
}

function normalizeStripeInvoiceId(value) {
    return normalizeStripeResourceId(value, "in");
}

function normalizeSiteSubscriptionStatus(value) {
    const normalized = normalizeText(value || "PENDING");
    return SITE_SUBSCRIPTION_STATUSES.includes(normalized) ? normalized : "PENDING";
}

function normalizeSiteSubscriptionBillingStatus(value) {
    const normalized = normalizeText(value || "PENDING");
    return SITE_SUBSCRIPTION_BILLING_STATUSES.includes(normalized) ? normalized : "PENDING";
}

function normalizeSiteSubscriptionProvisioningStatus(value) {
    const normalized = normalizeText(value || "PENDING_REVIEW");
    return SITE_SUBSCRIPTION_PROVISIONING_STATUSES.includes(normalized) ? normalized : "PENDING_REVIEW";
}

function normalizeStripeMetadataObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return Object.entries(value).reduce((accumulator, [key, rawValue]) => {
        const normalizedKey = normalizeFreeText(key || "");
        if (!normalizedKey) return accumulator;
        accumulator[normalizedKey] = normalizeFreeText(rawValue || "");
        return accumulator;
    }, {});
}

function toIsoFromUnixTimestamp(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
        ? new Date(parsed * 1000).toISOString()
        : null;
}

function deriveSiteBillingStatusFromStripeStatus(status, paymentStatus = "") {
    const normalizedStatus = normalizeSiteSubscriptionStatus(status);
    const normalizedPaymentStatus = normalizeText(paymentStatus || "");
    if (normalizedStatus === "ACTIVE" || normalizedStatus === "TRIALING") return "PAID";
    if (normalizedStatus === "PAST_DUE") return "PAST_DUE";
    if (normalizedStatus === "CANCELED") return "CANCELED";
    if (normalizedStatus === "UNPAID" || normalizedStatus === "INCOMPLETE_EXPIRED") return "PAYMENT_FAILED";
    if (normalizedPaymentStatus === "PAID") return "PAID";
    return "PENDING";
}

function isProvisionableSiteSubscriptionStatus(status) {
    const normalizedStatus = normalizeSiteSubscriptionStatus(status);
    return normalizedStatus === "TRIALING"
        || normalizedStatus === "ACTIVE"
        || normalizedStatus === "PAST_DUE"
        || normalizedStatus === "UNPAID";
}

function buildStripePlanFeatureFlags(planKey) {
    const flags = buildDefaultNewCompanyFeatureFlags();
    if (normalizeStripeCheckoutPlanKey(planKey) === "CUSTOMER_FACING_OPERATION") {
        flags[COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL] = true;
    }
    return flags;
}

function sanitizeStripeCheckoutLeadInput(input, { planKey = "" } = {}) {
    const plan = getStripeCheckoutPlanByKey(planKey);
    const fullName = normalizeFreeText(input?.fullName || input?.name || "");
    const workEmail = normalizeEmail(input?.workEmail || input?.email || "");
    const companyName = normalizeFreeText(input?.companyName || input?.company || "");
    const sourcePage = normalizeFreeText(input?.sourcePage || "");

    if (plan?.selfServe) {
        if (!fullName) {
            throw httpError(400, "Full name is required to start this plan.");
        }
        if (!workEmail) {
            throw httpError(400, "Work email is required to start this plan.");
        }
        if (!companyName) {
            throw httpError(400, "Company name is required to start this plan.");
        }
    }

    return {
        fullName,
        workEmail,
        companyName,
        sourcePage
    };
}

function mapSiteSubscriptionRow(row) {
    return {
        id: String(row.id),
        checkoutSessionId: row.checkout_session_id || "",
        stripeCustomerId: row.stripe_customer_id || "",
        stripeSubscriptionId: row.stripe_subscription_id || "",
        stripePriceId: row.stripe_price_id || "",
        stripeProductId: row.stripe_product_id || "",
        latestInvoiceId: row.latest_invoice_id || "",
        planKey: row.plan_key || "",
        planLabel: row.plan_label || "",
        companyName: row.company_name || "",
        companyAccountName: row.company_account_name || "",
        fullName: row.full_name || "",
        workEmail: row.work_email || "",
        sourcePage: row.source_page || "",
        status: normalizeSiteSubscriptionStatus(row.status),
        billingStatus: normalizeSiteSubscriptionBillingStatus(row.billing_status),
        checkoutStatus: row.checkout_status || "",
        paymentStatus: row.payment_status || "",
        provisioningStatus: normalizeSiteSubscriptionProvisioningStatus(row.provisioning_status),
        metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {},
        lastEventId: row.last_event_id || "",
        lastEventType: row.last_event_type || "",
        currentPeriodStart: row.current_period_start ? new Date(row.current_period_start).toISOString() : null,
        currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
        trialStartedAt: row.trial_started_at ? new Date(row.trial_started_at).toISOString() : null,
        trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
        cancelAt: row.cancel_at ? new Date(row.cancel_at).toISOString() : null,
        canceledAt: row.canceled_at ? new Date(row.canceled_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

async function getSiteSubscriptionRowByCheckoutSessionId(client, checkoutSessionId) {
    const normalizedId = normalizeStripeCheckoutSessionId(checkoutSessionId);
    if (!normalizedId) return null;
    const result = await client.query(
        "select * from site_subscriptions where checkout_session_id = $1 limit 1",
        [normalizedId]
    );
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function getSiteSubscriptionRowByStripeSubscriptionId(client, stripeSubscriptionId) {
    const normalizedId = normalizeStripeSubscriptionId(stripeSubscriptionId);
    if (!normalizedId) return null;
    const result = await client.query(
        "select * from site_subscriptions where stripe_subscription_id = $1 limit 1",
        [normalizedId]
    );
    return result.rowCount === 1 ? result.rows[0] : null;
}

async function findSiteSubscriptionRowByStripeReferences(client, { checkoutSessionId = "", stripeSubscriptionId = "", stripeCustomerId = "" } = {}) {
    const normalizedCheckoutSessionId = normalizeStripeCheckoutSessionId(checkoutSessionId);
    const normalizedStripeSubscriptionId = normalizeStripeSubscriptionId(stripeSubscriptionId);
    const normalizedStripeCustomerId = normalizeStripeCustomerId(stripeCustomerId);

    if (normalizedCheckoutSessionId) {
        const existingBySession = await getSiteSubscriptionRowByCheckoutSessionId(client, normalizedCheckoutSessionId);
        if (existingBySession) return existingBySession;
    }
    if (normalizedStripeSubscriptionId) {
        const existingBySubscription = await getSiteSubscriptionRowByStripeSubscriptionId(client, normalizedStripeSubscriptionId);
        if (existingBySubscription) return existingBySubscription;
    }
    if (normalizedStripeCustomerId) {
        const result = await client.query(
            "select * from site_subscriptions where stripe_customer_id = $1 order by created_at desc limit 1",
            [normalizedStripeCustomerId]
        );
        if (result.rowCount === 1) return result.rows[0];
    }
    return null;
}

async function upsertSiteSubscriptionRecord(client, rawInput) {
    const existing = await findSiteSubscriptionRowByStripeReferences(client, rawInput);
    const existingMetadata = existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? existing.metadata
        : {};
    const inputMetadata = normalizeStripeMetadataObject(rawInput?.metadata);
    const plan = getStripeCheckoutPlanByKey(rawInput?.planKey || existing?.plan_key || "");
    const merged = {
        checkoutSessionId: normalizeStripeCheckoutSessionId(rawInput?.checkoutSessionId || existing?.checkout_session_id),
        stripeCustomerId: normalizeStripeCustomerId(rawInput?.stripeCustomerId || existing?.stripe_customer_id),
        stripeSubscriptionId: normalizeStripeSubscriptionId(rawInput?.stripeSubscriptionId || existing?.stripe_subscription_id),
        stripePriceId: normalizeStripePriceId(rawInput?.stripePriceId || existing?.stripe_price_id || plan?.priceId),
        stripeProductId: normalizeStripeResourceId(rawInput?.stripeProductId || existing?.stripe_product_id),
        latestInvoiceId: normalizeStripeInvoiceId(rawInput?.latestInvoiceId || existing?.latest_invoice_id),
        planKey: normalizeStripeCheckoutPlanKey(rawInput?.planKey || existing?.plan_key || plan?.key),
        planLabel: normalizeFreeText(rawInput?.planLabel || existing?.plan_label || plan?.label || ""),
        companyName: normalizeFreeText(rawInput?.companyName || existing?.company_name),
        companyAccountName: normalizeText(rawInput?.companyAccountName || rawInput?.companyName || existing?.company_account_name || existing?.company_name),
        fullName: normalizeFreeText(rawInput?.fullName || existing?.full_name),
        workEmail: normalizeEmail(rawInput?.workEmail || existing?.work_email),
        sourcePage: normalizeFreeText(rawInput?.sourcePage || existing?.source_page),
        status: normalizeSiteSubscriptionStatus(rawInput?.status || existing?.status || "PENDING"),
        billingStatus: normalizeSiteSubscriptionBillingStatus(rawInput?.billingStatus || existing?.billing_status || "PENDING"),
        checkoutStatus: normalizeText(rawInput?.checkoutStatus || existing?.checkout_status || ""),
        paymentStatus: normalizeText(rawInput?.paymentStatus || existing?.payment_status || ""),
        provisioningStatus: normalizeSiteSubscriptionProvisioningStatus(rawInput?.provisioningStatus || existing?.provisioning_status || "PENDING_REVIEW"),
        metadata: {
            ...existingMetadata,
            ...inputMetadata
        },
        lastEventId: normalizeFreeText(rawInput?.lastEventId || existing?.last_event_id),
        lastEventType: normalizeFreeText(rawInput?.lastEventType || existing?.last_event_type),
        currentPeriodStart: rawInput?.currentPeriodStart || (existing?.current_period_start ? new Date(existing.current_period_start).toISOString() : null),
        currentPeriodEnd: rawInput?.currentPeriodEnd || (existing?.current_period_end ? new Date(existing.current_period_end).toISOString() : null),
        trialStartedAt: rawInput?.trialStartedAt || (existing?.trial_started_at ? new Date(existing.trial_started_at).toISOString() : null),
        trialEndsAt: rawInput?.trialEndsAt || (existing?.trial_ends_at ? new Date(existing.trial_ends_at).toISOString() : null),
        cancelAt: rawInput?.cancelAt || (existing?.cancel_at ? new Date(existing.cancel_at).toISOString() : null),
        canceledAt: rawInput?.canceledAt || (existing?.canceled_at ? new Date(existing.canceled_at).toISOString() : null)
    };

    if (!merged.checkoutSessionId && !merged.stripeSubscriptionId && !merged.stripeCustomerId) {
        throw httpError(400, "A Stripe checkout, subscription, or customer reference is required.");
    }

    const params = [
        merged.checkoutSessionId,
        merged.stripeCustomerId,
        merged.stripeSubscriptionId,
        merged.stripePriceId,
        merged.stripeProductId,
        merged.latestInvoiceId,
        merged.planKey,
        merged.planLabel,
        merged.companyName,
        merged.companyAccountName,
        merged.fullName,
        merged.workEmail,
        merged.sourcePage,
        merged.status,
        merged.billingStatus,
        merged.checkoutStatus,
        merged.paymentStatus,
        merged.provisioningStatus,
        JSON.stringify(merged.metadata || {}),
        merged.lastEventId,
        merged.lastEventType,
        merged.currentPeriodStart,
        merged.currentPeriodEnd,
        merged.trialStartedAt,
        merged.trialEndsAt,
        merged.cancelAt,
        merged.canceledAt
    ];

    const result = existing
        ? await client.query(
            `
                update site_subscriptions
                set
                    checkout_session_id = $1,
                    stripe_customer_id = $2,
                    stripe_subscription_id = $3,
                    stripe_price_id = $4,
                    stripe_product_id = $5,
                    latest_invoice_id = $6,
                    plan_key = $7,
                    plan_label = $8,
                    company_name = $9,
                    company_account_name = $10,
                    full_name = $11,
                    work_email = $12,
                    source_page = $13,
                    status = $14,
                    billing_status = $15,
                    checkout_status = $16,
                    payment_status = $17,
                    provisioning_status = $18,
                    metadata = $19::jsonb,
                    last_event_id = $20,
                    last_event_type = $21,
                    current_period_start = $22,
                    current_period_end = $23,
                    trial_started_at = $24,
                    trial_ends_at = $25,
                    cancel_at = $26,
                    canceled_at = $27,
                    updated_at = now()
                where id = $28
                returning *
            `,
            [...params, existing.id]
        )
        : await client.query(
            `
                insert into site_subscriptions (
                    checkout_session_id, stripe_customer_id, stripe_subscription_id,
                    stripe_price_id, stripe_product_id, latest_invoice_id,
                    plan_key, plan_label, company_name, company_account_name,
                    full_name, work_email, source_page,
                    status, billing_status, checkout_status, payment_status,
                    provisioning_status, metadata, last_event_id, last_event_type,
                    current_period_start, current_period_end, trial_started_at, trial_ends_at,
                    cancel_at, canceled_at
                )
                values (
                    $1, $2, $3,
                    $4, $5, $6,
                    $7, $8, $9, $10,
                    $11, $12, $13,
                    $14, $15, $16, $17,
                    $18, $19::jsonb, $20, $21,
                    $22, $23, $24, $25,
                    $26, $27
                )
                returning *
            `,
            params
        );

    return result.rows[0] ? mapSiteSubscriptionRow(result.rows[0]) : null;
}

function buildPendingSiteSubscriptionEntry(session, input = {}) {
    const plan = getStripeCheckoutPlanByKey(input?.planKey);
    return {
        checkoutSessionId: session.id,
        stripeCustomerId: normalizeStripeCustomerId(session.customer),
        stripeSubscriptionId: normalizeStripeSubscriptionId(session.subscription),
        stripePriceId: normalizeStripePriceId(plan?.priceId),
        planKey: plan?.key || normalizeStripeCheckoutPlanKey(input?.planKey),
        planLabel: plan?.label || "",
        companyName: normalizeFreeText(input?.companyName || session.metadata?.companyName || ""),
        companyAccountName: normalizeText(input?.companyName || session.metadata?.companyName || ""),
        fullName: normalizeFreeText(input?.fullName || session.metadata?.fullName || ""),
        workEmail: normalizeEmail(input?.workEmail || session.customer_email || session.customer_details?.email || ""),
        sourcePage: normalizeFreeText(input?.sourcePage || session.metadata?.sourcePage || ""),
        status: "PENDING",
        billingStatus: "PENDING",
        checkoutStatus: normalizeText(session.status || ""),
        paymentStatus: normalizeText(session.payment_status || ""),
        provisioningStatus: "PENDING_REVIEW",
        metadata: {
            ...normalizeStripeMetadataObject(session.metadata),
            sourcePage: normalizeFreeText(input?.sourcePage || session.metadata?.sourcePage || "")
        }
    };
}

function buildSiteSubscriptionEntryFromStripeSubscription(subscription, fallback = {}) {
    const metadata = normalizeStripeMetadataObject(subscription?.metadata);
    const plan = getStripeCheckoutPlanByKey(metadata.planKey || fallback.planKey);
    const status = normalizeSiteSubscriptionStatus(subscription?.status || fallback.status || "PENDING");
    return {
        checkoutSessionId: normalizeStripeCheckoutSessionId(fallback.checkoutSessionId),
        stripeCustomerId: normalizeStripeCustomerId(subscription?.customer || fallback.stripeCustomerId),
        stripeSubscriptionId: normalizeStripeSubscriptionId(subscription?.id || fallback.stripeSubscriptionId),
        stripePriceId: normalizeStripePriceId(subscription?.items?.data?.[0]?.price?.id || fallback.stripePriceId || plan?.priceId),
        stripeProductId: normalizeStripeResourceId(subscription?.items?.data?.[0]?.price?.product || fallback.stripeProductId),
        latestInvoiceId: normalizeStripeInvoiceId(subscription?.latest_invoice || fallback.latestInvoiceId),
        planKey: plan?.key || normalizeStripeCheckoutPlanKey(metadata.planKey || fallback.planKey),
        planLabel: plan?.label || normalizeFreeText(metadata.planLabel || fallback.planLabel || ""),
        companyName: normalizeFreeText(metadata.companyName || fallback.companyName || ""),
        companyAccountName: normalizeText(metadata.companyName || fallback.companyAccountName || fallback.companyName || ""),
        fullName: normalizeFreeText(metadata.fullName || fallback.fullName || ""),
        workEmail: normalizeEmail(fallback.workEmail || ""),
        sourcePage: normalizeFreeText(metadata.sourcePage || fallback.sourcePage || ""),
        status,
        billingStatus: deriveSiteBillingStatusFromStripeStatus(status, fallback.paymentStatus),
        checkoutStatus: normalizeText(fallback.checkoutStatus || ""),
        paymentStatus: normalizeText(fallback.paymentStatus || ""),
        provisioningStatus: normalizeSiteSubscriptionProvisioningStatus(fallback.provisioningStatus || "PENDING_REVIEW"),
        metadata,
        lastEventId: normalizeFreeText(fallback.lastEventId),
        lastEventType: normalizeFreeText(fallback.lastEventType),
        currentPeriodStart: toIsoFromUnixTimestamp(subscription?.current_period_start),
        currentPeriodEnd: toIsoFromUnixTimestamp(subscription?.current_period_end),
        trialStartedAt: toIsoFromUnixTimestamp(subscription?.trial_start),
        trialEndsAt: toIsoFromUnixTimestamp(subscription?.trial_end),
        cancelAt: toIsoFromUnixTimestamp(subscription?.cancel_at),
        canceledAt: toIsoFromUnixTimestamp(subscription?.canceled_at)
    };
}

function buildSiteSubscriptionEntryFromCheckoutSession(session, fallback = {}) {
    const metadata = normalizeStripeMetadataObject(session?.metadata);
    const subscription = session?.subscription && typeof session.subscription === "object" && !Array.isArray(session.subscription)
        ? session.subscription
        : null;
    const plan = getStripeCheckoutPlanByKey(metadata.planKey || fallback.planKey);
    const baseStatus = subscription?.status
        ? normalizeSiteSubscriptionStatus(subscription.status)
        : normalizeText(session?.payment_status) === "PAID"
            ? "ACTIVE"
            : "PENDING";
    const paymentStatus = normalizeText(session?.payment_status || fallback.paymentStatus || "");

    return {
        checkoutSessionId: normalizeStripeCheckoutSessionId(session?.id || fallback.checkoutSessionId),
        stripeCustomerId: normalizeStripeCustomerId(session?.customer || fallback.stripeCustomerId),
        stripeSubscriptionId: normalizeStripeSubscriptionId(subscription?.id || session?.subscription || fallback.stripeSubscriptionId),
        stripePriceId: normalizeStripePriceId(subscription?.items?.data?.[0]?.price?.id || fallback.stripePriceId || plan?.priceId),
        stripeProductId: normalizeStripeResourceId(subscription?.items?.data?.[0]?.price?.product || fallback.stripeProductId),
        latestInvoiceId: normalizeStripeInvoiceId(subscription?.latest_invoice || fallback.latestInvoiceId),
        planKey: plan?.key || normalizeStripeCheckoutPlanKey(metadata.planKey || fallback.planKey),
        planLabel: plan?.label || normalizeFreeText(metadata.planLabel || fallback.planLabel || ""),
        companyName: normalizeFreeText(metadata.companyName || fallback.companyName || session?.client_reference_id || ""),
        companyAccountName: normalizeText(metadata.companyName || fallback.companyAccountName || fallback.companyName || session?.client_reference_id || ""),
        fullName: normalizeFreeText(metadata.fullName || fallback.fullName || session?.customer_details?.name || ""),
        workEmail: normalizeEmail(fallback.workEmail || session?.customer_email || session?.customer_details?.email || ""),
        sourcePage: normalizeFreeText(metadata.sourcePage || fallback.sourcePage || ""),
        status: baseStatus,
        billingStatus: deriveSiteBillingStatusFromStripeStatus(baseStatus, paymentStatus),
        checkoutStatus: normalizeText(session?.status || fallback.checkoutStatus || ""),
        paymentStatus,
        provisioningStatus: normalizeSiteSubscriptionProvisioningStatus(fallback.provisioningStatus || "PENDING_REVIEW"),
        metadata,
        lastEventId: normalizeFreeText(fallback.lastEventId),
        lastEventType: normalizeFreeText(fallback.lastEventType),
        currentPeriodStart: subscription ? toIsoFromUnixTimestamp(subscription.current_period_start) : null,
        currentPeriodEnd: subscription ? toIsoFromUnixTimestamp(subscription.current_period_end) : null,
        trialStartedAt: subscription ? toIsoFromUnixTimestamp(subscription.trial_start) : null,
        trialEndsAt: subscription ? toIsoFromUnixTimestamp(subscription.trial_end) : null,
        cancelAt: subscription ? toIsoFromUnixTimestamp(subscription.cancel_at) : null,
        canceledAt: subscription ? toIsoFromUnixTimestamp(subscription.canceled_at) : null
    };
}

async function retrieveStripeCheckoutSession(checkoutSessionId) {
    const normalizedId = normalizeStripeCheckoutSessionId(checkoutSessionId);
    if (!normalizedId) {
        throw httpError(400, "A valid Stripe checkout session id is required.");
    }
    const stripe = getStripeClient();
    return await stripe.checkout.sessions.retrieve(normalizedId, {
        expand: ["subscription"]
    });
}

async function retrieveStripeSubscription(subscriptionId) {
    const normalizedId = normalizeStripeSubscriptionId(subscriptionId);
    if (!normalizedId) {
        throw httpError(400, "A valid Stripe subscription id is required.");
    }
    const stripe = getStripeClient();
    return await stripe.subscriptions.retrieve(normalizedId);
}

async function getStripeCheckoutSessionSummary(checkoutSessionId) {
    assertDatabaseAvailable();
    const row = await getSiteSubscriptionRowByCheckoutSessionId(pool, checkoutSessionId);
    if (row && normalizeSiteSubscriptionStatus(row.status) !== "PENDING" && normalizeText(row.checkout_status) !== "OPEN") {
        const mapped = mapSiteSubscriptionRow(row);
        return {
            ...mapped,
            isProvisionable: isProvisionableSiteSubscriptionStatus(mapped.status)
        };
    }

    const session = await retrieveStripeCheckoutSession(checkoutSessionId);
    const entry = buildSiteSubscriptionEntryFromCheckoutSession(session, row ? mapSiteSubscriptionRow(row) : {});
    if (row || normalizeStripeCheckoutSessionId(entry.checkoutSessionId)) {
        await withTransaction(async (client) => {
            await upsertSiteSubscriptionRecord(client, entry);
        });
    }
    return {
        ...entry,
        isProvisionable: isProvisionableSiteSubscriptionStatus(entry.status)
    };
}

async function markStripeWebhookEventProcessed(client, event) {
    const eventId = normalizeFreeText(event?.id || "");
    const eventType = normalizeFreeText(event?.type || "");
    if (!eventId || !eventType) {
        throw httpError(400, "Stripe webhook event metadata is incomplete.");
    }
    const result = await client.query(
        `
            insert into stripe_webhook_events (event_id, event_type)
            values ($1, $2)
            on conflict (event_id) do nothing
            returning event_id
        `,
        [eventId, eventType]
    );
    return result.rowCount === 1;
}

async function ensureSiteSubscriptionCompanyProvisioned(client, subscription) {
    if (!subscription || !subscription.companyAccountName || !isProvisionableSiteSubscriptionStatus(subscription.status)) {
        return subscription;
    }

    await upsertOwnerMaster(client, {
        name: subscription.companyAccountName,
        legalName: subscription.companyName,
        contactName: subscription.fullName,
        email: subscription.workEmail,
        billingEmail: subscription.workEmail,
        portalLoginEmail: subscription.workEmail,
        note: "Created from Stripe self-serve signup.",
        featureFlags: buildStripePlanFeatureFlags(subscription.planKey),
        featureFlagsUpdatedAt: new Date().toISOString(),
        featureFlagsUpdatedBy: "stripe-signup"
    });

    if (normalizeSiteSubscriptionProvisioningStatus(subscription.provisioningStatus) === "OWNER_CREATED") {
        return subscription;
    }

    const updated = await upsertSiteSubscriptionRecord(client, {
        checkoutSessionId: subscription.checkoutSessionId,
        stripeCustomerId: subscription.stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        provisioningStatus: "OWNER_CREATED"
    });

    await insertActivity(
        client,
        "marketing",
        `Provisioned company shell for ${updated.companyAccountName}`,
        [updated.planLabel, updated.workEmail, "Stripe signup"].filter(Boolean).join(" | ")
    );

    return updated;
}

async function handleStripeCheckoutSessionCompleted(client, event) {
    const checkoutSessionId = normalizeStripeCheckoutSessionId(event?.data?.object?.id);
    if (!checkoutSessionId) return { notification: null };

    const session = await retrieveStripeCheckoutSession(checkoutSessionId);
    let saved = await upsertSiteSubscriptionRecord(
        client,
        buildSiteSubscriptionEntryFromCheckoutSession(session, {
            lastEventId: event.id,
            lastEventType: event.type
        })
    );
    saved = await ensureSiteSubscriptionCompanyProvisioned(client, saved);

    await insertActivity(
        client,
        "marketing",
        `Stripe signup started for ${saved.companyName || saved.companyAccountName || saved.workEmail}`,
        [saved.planLabel, saved.status, saved.workEmail].filter(Boolean).join(" | ")
    );

    return {
        notification: {
            kind: "NEW_SIGNUP",
            subscription: saved
        }
    };
}

async function handleStripeSubscriptionLifecycleEvent(client, event) {
    const subscriptionObject = event?.data?.object;
    const subscriptionId = normalizeStripeSubscriptionId(subscriptionObject?.id);
    if (!subscriptionId) return { notification: null };

    const existing = await getSiteSubscriptionRowByStripeSubscriptionId(client, subscriptionId);
    let saved = await upsertSiteSubscriptionRecord(
        client,
        buildSiteSubscriptionEntryFromStripeSubscription(subscriptionObject, {
            checkoutSessionId: existing?.checkout_session_id || "",
            companyName: existing?.company_name || "",
            companyAccountName: existing?.company_account_name || "",
            fullName: existing?.full_name || "",
            workEmail: existing?.work_email || "",
            sourcePage: existing?.source_page || "",
            paymentStatus: existing?.payment_status || "",
            provisioningStatus: existing?.provisioning_status || "PENDING_REVIEW",
            lastEventId: event.id,
            lastEventType: event.type
        })
    );
    saved = await ensureSiteSubscriptionCompanyProvisioned(client, saved);
    return { notification: null };
}

async function handleStripeInvoiceLifecycleEvent(client, event) {
    const invoice = event?.data?.object;
    const subscriptionId = normalizeStripeSubscriptionId(invoice?.subscription);
    const existing = await getSiteSubscriptionRowByStripeSubscriptionId(client, subscriptionId);
    const subscriptionObject = subscriptionId ? await retrieveStripeSubscription(subscriptionId) : null;

    let saved = await upsertSiteSubscriptionRecord(
        client,
        {
            ...(subscriptionObject
                ? buildSiteSubscriptionEntryFromStripeSubscription(subscriptionObject, {
                    checkoutSessionId: existing?.checkout_session_id || "",
                    companyName: existing?.company_name || "",
                    companyAccountName: existing?.company_account_name || "",
                    fullName: existing?.full_name || "",
                    workEmail: existing?.work_email || normalizeEmail(invoice?.customer_email || ""),
                    sourcePage: existing?.source_page || "",
                    paymentStatus: normalizeText(invoice?.status || ""),
                    provisioningStatus: existing?.provisioning_status || "PENDING_REVIEW"
                })
                : {}),
            stripeCustomerId: normalizeStripeCustomerId(invoice?.customer || existing?.stripe_customer_id),
            stripeSubscriptionId: subscriptionId || existing?.stripe_subscription_id || "",
            latestInvoiceId: normalizeStripeInvoiceId(invoice?.id || existing?.latest_invoice_id),
            workEmail: normalizeEmail(invoice?.customer_email || existing?.work_email || ""),
            billingStatus: event.type === "invoice.paid" ? "PAID" : "PAYMENT_FAILED",
            paymentStatus: normalizeText(invoice?.status || ""),
            lastEventId: event.id,
            lastEventType: event.type
        }
    );
    saved = await ensureSiteSubscriptionCompanyProvisioned(client, saved);

    if (event.type === "invoice.payment_failed") {
        await insertActivity(
            client,
            "marketing",
            `Stripe payment failed for ${saved.companyName || saved.companyAccountName || saved.workEmail}`,
            [saved.planLabel, saved.workEmail, saved.latestInvoiceId].filter(Boolean).join(" | ")
        );
        return {
            notification: {
                kind: "PAYMENT_FAILED",
                subscription: saved
            }
        };
    }

    return { notification: null };
}

async function processStripeWebhookEvent(event) {
    return await withTransaction(async (client) => {
        const isNewEvent = await markStripeWebhookEventProcessed(client, event);
        if (!isNewEvent) {
            return { duplicate: true, notification: null };
        }

        switch (event.type) {
            case "checkout.session.completed":
                return await handleStripeCheckoutSessionCompleted(client, event);
            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted":
                return await handleStripeSubscriptionLifecycleEvent(client, event);
            case "invoice.paid":
            case "invoice.payment_failed":
                return await handleStripeInvoiceLifecycleEvent(client, event);
            default:
                return { duplicate: false, notification: null };
        }
    });
}

function buildStripeSubscriptionNotificationText(notification) {
    const subscription = notification?.subscription || {};
    const label = notification?.kind === "PAYMENT_FAILED" ? "Stripe payment failed" : "New Stripe signup";
    return [
        `${label} for ${subscription.companyName || subscription.companyAccountName || subscription.workEmail || "Unknown company"}`,
        `Plan: ${subscription.planLabel || subscription.planKey || ""}`,
        `Status: ${subscription.status || ""}`,
        `Billing Status: ${subscription.billingStatus || ""}`,
        subscription.fullName ? `Contact: ${subscription.fullName}` : "",
        subscription.workEmail ? `Work Email: ${subscription.workEmail}` : "",
        subscription.companyAccountName ? `Company Code: ${subscription.companyAccountName}` : "",
        subscription.checkoutSessionId ? `Checkout Session: ${subscription.checkoutSessionId}` : "",
        subscription.stripeSubscriptionId ? `Subscription: ${subscription.stripeSubscriptionId}` : "",
        subscription.latestInvoiceId ? `Invoice: ${subscription.latestInvoiceId}` : "",
        subscription.provisioningStatus ? `Provisioning: ${subscription.provisioningStatus}` : ""
    ].filter(Boolean).join("\n");
}

function buildStripeSubscriptionNotificationHtml(notification) {
    const subscription = notification?.subscription || {};
    const label = notification?.kind === "PAYMENT_FAILED" ? "Stripe payment failed" : "New Stripe signup";
    const rows = [
        ["Plan", subscription.planLabel || subscription.planKey || ""],
        ["Status", subscription.status || ""],
        ["Billing Status", subscription.billingStatus || ""],
        ["Company", subscription.companyName || subscription.companyAccountName || ""],
        ["Contact", subscription.fullName || ""],
        ["Work Email", subscription.workEmail || ""],
        ["Provisioning", subscription.provisioningStatus || ""],
        ["Checkout Session", subscription.checkoutSessionId || ""],
        ["Subscription", subscription.stripeSubscriptionId || ""],
        ["Invoice", subscription.latestInvoiceId || ""]
    ].filter(([, value]) => value);

    return `
        <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5;">
            <h2 style="margin:0 0 12px;">${escapeHtml(label)}</h2>
            <table style="border-collapse:collapse;width:100%;max-width:720px;">
                ${rows.map(([name, value]) => `
                    <tr>
                        <td style="padding:6px 0;font-weight:600;vertical-align:top;width:180px;">${escapeHtml(name)}</td>
                        <td style="padding:6px 0;">${escapeHtml(value)}</td>
                    </tr>
                `).join("")}
            </table>
        </div>
    `;
}

async function sendStripeSubscriptionNotification(notification) {
    const recipients = getDemoRequestRecipients();
    if (!recipients.length || !hasSystemEmailConfig() || !notification?.subscription) {
        return [];
    }

    const transporter = getSystemMailer();
    const subjectPrefix = notification.kind === "PAYMENT_FAILED" ? "WMS365 Stripe payment failed" : "New WMS365 Stripe signup";
    await transporter.sendMail({
        from: SMTP_FROM,
        to: recipients.join(", "),
        replyTo: notification.subscription.workEmail || SMTP_REPLY_TO || undefined,
        subject: `${subjectPrefix} - ${notification.subscription.companyName || notification.subscription.companyAccountName || "Unknown company"}`,
        text: buildStripeSubscriptionNotificationText(notification),
        html: buildStripeSubscriptionNotificationHtml(notification)
    });
    return recipients;
}

function normalizeStripeCheckoutPlanKey(value) {
    const normalized = normalizeText(value || "");
    if (!normalized) return "";
    if (normalized === "LAUNCH" || normalized === "CORE" || normalized === "LAUNCHWAREHOUSE") {
        return "LAUNCH_WAREHOUSE";
    }
    if (normalized === "GROWTH" || normalized === "CUSTOMERFACING" || normalized === "CUSTOMERFACINGOPERATION") {
        return "CUSTOMER_FACING_OPERATION";
    }
    return Object.prototype.hasOwnProperty.call(STRIPE_CHECKOUT_PLANS, normalized) ? normalized : "";
}

function normalizeOriginUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
        return new URL(text).origin.toLowerCase();
    } catch {
        return "";
    }
}

function addOriginVariant(origins, value) {
    const origin = normalizeOriginUrl(value);
    if (!origin) return;
    origins.add(origin);
    try {
        const url = new URL(origin);
        if (url.hostname.startsWith("www.")) {
            url.hostname = url.hostname.slice(4);
            origins.add(url.origin.toLowerCase());
        } else if (url.hostname.includes(".")) {
            url.hostname = `www.${url.hostname}`;
            origins.add(url.origin.toLowerCase());
        }
    } catch {
        // Ignore invalid alternates after the main origin is accepted.
    }
}

function buildPublicApiAllowedOrigins() {
    const origins = new Set();
    addOriginVariant(origins, PUBLIC_SITE_URL);
    String(PUBLIC_SITE_ALLOWED_ORIGINS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((value) => addOriginVariant(origins, value));
    return origins;
}

function getRequestOrigin(req) {
    const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "https";
    const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
    return host ? `${protocol}://${host}` : "";
}

function appendVaryHeader(res, value) {
    const current = String(res.getHeader("Vary") || "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const normalized = value.toLowerCase();
    if (current.some((entry) => entry.toLowerCase() === normalized)) {
        return;
    }
    current.push(value);
    res.setHeader("Vary", current.join(", "));
}

function applyPublicApiCorsHeaders(req, res) {
    const requestOrigin = normalizeOriginUrl(req.get("origin") || "");
    if (!requestOrigin) {
        return true;
    }
    const sameOrigin = requestOrigin === normalizeOriginUrl(getRequestOrigin(req));
    const allowed = sameOrigin || PUBLIC_API_ALLOWED_ORIGINS.has(requestOrigin);
    appendVaryHeader(res, "Origin");
    if (!allowed) {
        return false;
    }
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return true;
}

function getStripeCheckoutPlanByKey(planKey) {
    const normalizedKey = normalizeStripeCheckoutPlanKey(planKey);
    return normalizedKey ? STRIPE_CHECKOUT_PLANS[normalizedKey] || null : null;
}

function getStripeCheckoutPlanSummaries() {
    return Object.values(STRIPE_CHECKOUT_PLANS).map((plan) => ({
        key: plan.key,
        label: plan.label,
        marketingPriceLabel: plan.marketingPriceLabel || "",
        selfServe: plan.selfServe === true,
        enabled: !!Stripe && !!STRIPE_SECRET_KEY && !!plan.priceId
    }));
}

function hasStripeCheckoutConfig() {
    return !!Stripe && !!STRIPE_SECRET_KEY && Object.values(STRIPE_CHECKOUT_PLANS).some((plan) => !!plan.priceId);
}

function getStripeClient() {
    if (!Stripe || !STRIPE_SECRET_KEY) {
        throw httpError(503, "Stripe checkout is not configured yet. Add STRIPE_SECRET_KEY first.");
    }
    if (!stripeClient) {
        stripeClient = new Stripe(STRIPE_SECRET_KEY);
    }
    return stripeClient;
}

function getPublicRequestOrigin(req) {
    if (PUBLIC_SITE_URL) {
        return PUBLIC_SITE_URL;
    }
    const requestOrigin = getRequestOrigin(req);
    if (!requestOrigin) {
        throw httpError(400, "Public site URL is not available for checkout.");
    }
    return requestOrigin;
}

async function createStripeCheckoutSessionForSite(req, input) {
    const plan = getStripeCheckoutPlanByKey(input?.planKey);
    if (!plan) {
        throw httpError(400, "Choose a valid plan for Stripe checkout.");
    }
    if (!plan.priceId) {
        throw httpError(503, `Stripe checkout is not configured for ${plan.label} yet.`);
    }

    const stripe = getStripeClient();
    const origin = getPublicRequestOrigin(req);
    const customerEmail = normalizeEmail(input?.customerEmail || "");
    const fullName = normalizeFreeText(input?.fullName || "");
    const companyName = normalizeFreeText(input?.companyName || "");
    const sourcePage = normalizeFreeText(input?.sourcePage || "");
    const successUrl = `${origin}${plan.successPath}${plan.successPath.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;

    return await stripe.checkout.sessions.create({
        mode: plan.mode,
        line_items: [
            {
                price: plan.priceId,
                quantity: 1
            }
        ],
        success_url: successUrl,
        cancel_url: `${origin}${plan.cancelPath}`,
        customer_email: customerEmail || undefined,
        client_reference_id: normalizeFreeText(companyName || fullName || plan.key).slice(0, 200) || undefined,
        allow_promotion_codes: true,
        metadata: {
            planKey: plan.key,
            planLabel: plan.label,
            companyName: companyName || "",
            fullName: fullName || "",
            sourcePage: sourcePage || ""
        },
        subscription_data: {
            metadata: {
                planKey: plan.key,
                planLabel: plan.label,
                companyName: companyName || "",
                fullName: fullName || "",
                sourcePage: sourcePage || ""
            }
        }
    });
}

async function getPortalShipmentRecipients(client, accountName) {
    const normalizedAccount = normalizeText(accountName);
    const recipients = new Set();
    const addRecipient = (value) => {
        const email = normalizeEmail(value);
        if (email) recipients.add(email);
    };

    const portalUsers = await client.query(
        `
            select email
            from portal_vendor_access
            where account_name = $1
              and is_active = true
              and email is not null
              and btrim(email) <> ''
            order by email asc
        `,
        [normalizedAccount]
    );
    portalUsers.rows.forEach((row) => addRecipient(row.email));

    const ownerAccount = await client.query(
        `
            select email, billing_email, ap_email, portal_login_email
            from owner_accounts
            where name = $1
            limit 1
        `,
        [normalizedAccount]
    );
    if (ownerAccount.rowCount === 1) {
        const row = ownerAccount.rows[0];
        addRecipient(row.portal_login_email);
        addRecipient(row.billing_email);
        addRecipient(row.ap_email);
        addRecipient(row.email);
    }

    return [...recipients];
}

function getPortalOrderReleaseRecipients() {
    const recipients = new Set();
    const addRecipient = (value) => {
        const email = normalizeEmail(value);
        if (email && isValidEmailAddress(email) && !email.endsWith(".local")) {
            recipients.add(email);
        }
    };

    normalizeEmailList(ORDER_RELEASE_TO).forEach(addRecipient);
    if (!recipients.size) {
        addRecipient(SMTP_REPLY_TO);
        addRecipient(DEMO_REQUEST_TO);
        addRecipient(DEFAULT_ADMIN_EMAIL);
    }

    return [...recipients];
}

function formatPortalOrderShipToAddress(order) {
    return [
        normalizeFreeText(order.shipToName || ""),
        normalizeFreeText(order.shipToAddress1 || ""),
        normalizeFreeText(order.shipToAddress2 || ""),
        [
            normalizeFreeText(order.shipToCity || ""),
            normalizeFreeText(order.shipToState || ""),
            normalizeFreeText(order.shipToPostalCode || "")
        ].filter(Boolean).join(", "),
        normalizeFreeText(order.shipToCountry || "")
    ].filter(Boolean).join(" | ");
}

function formatPortalOrderEventTimestamp(value) {
    const candidate = value ? new Date(value) : new Date();
    if (!Number.isFinite(candidate.getTime())) {
        return "";
    }
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(candidate);
}

function wrapPdfText(value, maxLength = 92) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return [""];

    const words = text.split(" ");
    const lines = [];
    let current = "";

    for (const word of words) {
        if (!current) {
            current = word;
            continue;
        }
        if (`${current} ${word}`.length <= maxLength) {
            current = `${current} ${word}`;
            continue;
        }
        lines.push(current);
        current = word;
    }

    if (current) {
        lines.push(current);
    }

    return lines;
}

function escapePdfText(value) {
    return String(value || "")
        .replace(/[^\x20-\x7E]/g, "?")
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)")
        .replace(/\r?\n/g, " ");
}

function createSimpleTextPdfBuffer(lines) {
    const normalizedLines = [];
    const sourceLines = Array.isArray(lines) ? lines : [];
    sourceLines.forEach((line) => {
        if (line == null) return;
        const text = String(line);
        if (!text.trim()) {
            normalizedLines.push("");
            return;
        }
        normalizedLines.push(...wrapPdfText(text));
    });

    const pageLineLimit = 46;
    const chunks = [];
    for (let index = 0; index < normalizedLines.length; index += pageLineLimit) {
        chunks.push(normalizedLines.slice(index, index + pageLineLimit));
    }
    if (!chunks.length) {
        chunks.push(["WMS365"]);
    }

    const pageIds = chunks.map((_, index) => 4 + (index * 2));
    const contentIds = chunks.map((_, index) => 5 + (index * 2));
    const objectBodies = new Array((chunks.length * 2) + 4);
    objectBodies[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objectBodies[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${chunks.length} >>`;
    objectBodies[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

    chunks.forEach((chunk, index) => {
        const pageId = pageIds[index];
        const contentId = contentIds[index];
        const contentStream = [
            "BT",
            "/F1 10 Tf",
            "14 TL",
            "50 760 Td",
            ...chunk.flatMap((line) => [`(${escapePdfText(line)}) Tj`, "T*"]),
            "ET"
        ].join("\n");
        const contentLength = Buffer.byteLength(contentStream, "utf8");
        objectBodies[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
        objectBodies[contentId] = `<< /Length ${contentLength} >>\nstream\n${contentStream}\nendstream`;
    });

    let pdf = "%PDF-1.4\n%WMS365\n";
    const offsets = [0];

    for (let index = 1; index < objectBodies.length; index += 1) {
        offsets[index] = Buffer.byteLength(pdf, "utf8");
        pdf += `${index} 0 obj\n${objectBodies[index]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, "utf8");
    pdf += `xref\n0 ${objectBodies.length}\n`;
    pdf += "0000000000 65535 f \n";
    for (let index = 1; index < objectBodies.length; index += 1) {
        pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objectBodies.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(pdf, "utf8");
}

function buildPortalOrderReleasePdf(order) {
    const releaseTimestamp = formatPortalOrderEventTimestamp(order.releasedAt || new Date());
    const lines = [
        "WMS365 Portal Order Release Copy",
        "",
        `Order Code: ${order.orderCode}`,
        `Company: ${order.accountName}`,
        `Status: ${order.status}`,
        releaseTimestamp ? `Released At: ${releaseTimestamp}` : "",
        order.poNumber ? `PO Number: ${order.poNumber}` : "",
        order.shippingReference ? `Shipping Reference: ${order.shippingReference}` : "",
        order.requestedShipDate ? `Requested Ship Date: ${order.requestedShipDate}` : "",
        "",
        "Warehouse Contact",
        order.contactName ? `Name: ${order.contactName}` : "Name: Not provided",
        order.contactPhone ? `Phone: ${order.contactPhone}` : "",
        "",
        "Ship To",
        order.shipToName ? `Name: ${order.shipToName}` : "",
        order.shipToPhone ? `Phone: ${order.shipToPhone}` : "",
        order.shipToAddress1 ? `Address 1: ${order.shipToAddress1}` : "",
        order.shipToAddress2 ? `Address 2: ${order.shipToAddress2}` : "",
        order.shipToCity || order.shipToState || order.shipToPostalCode
            ? `City / State / Postal: ${[order.shipToCity, order.shipToState, order.shipToPostalCode].filter(Boolean).join(", ")}`
            : "",
        order.shipToCountry ? `Country: ${order.shipToCountry}` : "",
        order.orderNotes ? "" : "",
        order.orderNotes ? "Order Notes" : "",
        order.orderNotes ? order.orderNotes : "",
        "",
        "Order Lines"
    ].filter((line, index, array) => line || (index > 0 && array[index - 1] !== ""));

    order.lines.forEach((line, index) => {
        lines.push(
            `${index + 1}. ${line.sku} | ${formatTrackedQuantity(line.quantity, line.trackingLevel)}${line.description ? ` | ${line.description}` : ""}${line.upc ? ` | UPC ${line.upc}` : ""}`
        );
    });

    const fileBuffer = createSimpleTextPdfBuffer(lines);
    const fileName = `wms365-${sanitizeFilenameSegment(order.orderCode || "order", "order")}-release-copy.pdf`;
    return {
        fileName,
        fileType: "application/pdf",
        fileSize: fileBuffer.length,
        fileBuffer
    };
}

async function savePortalReleasePdfCopy(
    client,
    order,
    pdfDocument,
    uploadedBy = "",
    {
        downloadPathPrefix = "/api/portal/order-documents",
        activityActor = ""
    } = {}
) {
    const existingResult = await client.query(
        `
            select *
            from portal_order_documents
            where order_id = $1
              and file_name = $2
            order by id desc
            limit 1
        `,
        [order.id, pdfDocument.fileName]
    );

    if (existingResult.rowCount === 1) {
        const currentOrder = await getPortalOrderById(client, order.id, order.accountName, downloadPathPrefix);
        return {
            order: currentOrder || order,
            document: mapPortalOrderDocumentRow(existingResult.rows[0], downloadPathPrefix),
            alreadySaved: true
        };
    }

    await insertPortalOrderDocuments(client, order.id, [pdfDocument], uploadedBy);
    await insertActivity(
        client,
        "order",
        `Saved portal order PDF ${order.orderCode}`,
        [
            order.accountName,
            pdfDocument.fileName,
            activityActor || uploadedBy || ""
        ].filter(Boolean).join(" | ")
    );

    const updatedOrder = await getPortalOrderById(client, order.id, order.accountName, downloadPathPrefix);
    const savedDocument = updatedOrder?.documents?.find((document) => document.fileName === pdfDocument.fileName) || null;
    return {
        order: updatedOrder || order,
        document: savedDocument,
        alreadySaved: false
    };
}

function buildPortalShipmentEmailText(order, confirmation, { isUpdate = false } = {}) {
    const lines = [
        `${isUpdate ? "Shipment confirmation updated" : "Shipment confirmation"} for ${order.orderCode}`,
        `Company: ${order.accountName}`,
        `Status: ${order.status}`,
        order.poNumber ? `PO Number: ${order.poNumber}` : "",
        order.shippingReference ? `Shipping Reference: ${order.shippingReference}` : "",
        order.requestedShipDate ? `Requested Ship Date: ${order.requestedShipDate}` : "",
        confirmation.confirmedShipDate ? `Confirmed Ship Date: ${confirmation.confirmedShipDate}` : "",
        confirmation.shippedCarrierName ? `Carrier: ${confirmation.shippedCarrierName}` : "",
        confirmation.shippedTrackingReference ? `Tracking / PRO / BOL: ${confirmation.shippedTrackingReference}` : "",
        order.contactName ? `Warehouse Contact: ${order.contactName}${order.contactPhone ? ` | ${order.contactPhone}` : ""}` : "",
        formatPortalOrderShipToAddress(order) ? `Ship To: ${formatPortalOrderShipToAddress(order)}` : "",
        confirmation.shippedConfirmationNote ? `Shipping Note: ${confirmation.shippedConfirmationNote}` : "",
        "",
        "Order Lines:"
    ];

    order.lines.forEach((line) => {
        lines.push(
            `- ${line.sku} | ${formatTrackedQuantity(line.quantity, line.trackingLevel)}${line.description ? ` | ${line.description}` : ""}${line.upc ? ` | UPC ${line.upc}` : ""}`
        );
    });

    if (confirmation.documents.length) {
        lines.push("", `Attached Documents (${confirmation.documents.length}):`);
        confirmation.documents.forEach((document) => lines.push(`- ${document.fileName}`));
    }

    return lines.filter((line, index, array) => line || (index > 0 && array[index - 1] !== "")).join("\n");
}

function buildPortalShipmentEmailHtml(order, confirmation, { isUpdate = false } = {}) {
    const linesHtml = order.lines.map((line) => `
        <tr>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(line.sku)}</td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(formatTrackedQuantity(line.quantity, line.trackingLevel))}</td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(line.description || "-")}</td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(line.upc || "-")}</td>
        </tr>
    `).join("");

    const documentList = confirmation.documents.length
        ? `
            <p style="margin:16px 0 8px;font-weight:600;">Attached Documents</p>
            <ul style="margin:0 0 16px 18px;padding:0;">
                ${confirmation.documents.map((document) => `<li>${escapeHtml(document.fileName)}</li>`).join("")}
            </ul>
        `
        : "";

    return `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
            <h2 style="margin:0 0 12px;">${escapeHtml(isUpdate ? "Shipment Confirmation Updated" : "Shipment Confirmed")}</h2>
            <p style="margin:0 0 16px;">Order <strong>${escapeHtml(order.orderCode)}</strong> for <strong>${escapeHtml(order.accountName)}</strong> has been ${isUpdate ? "updated" : "shipped"}.</p>
            <table style="border-collapse:collapse;width:100%;max-width:720px;">
                <tr><td style="padding:6px 0;font-weight:600;">PO Number</td><td style="padding:6px 0;">${escapeHtml(order.poNumber || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Shipping Reference</td><td style="padding:6px 0;">${escapeHtml(order.shippingReference || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Requested Ship Date</td><td style="padding:6px 0;">${escapeHtml(order.requestedShipDate || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Confirmed Ship Date</td><td style="padding:6px 0;">${escapeHtml(confirmation.confirmedShipDate || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Carrier</td><td style="padding:6px 0;">${escapeHtml(confirmation.shippedCarrierName || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Tracking / PRO / BOL</td><td style="padding:6px 0;">${escapeHtml(confirmation.shippedTrackingReference || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Ship To</td><td style="padding:6px 0;">${escapeHtml(formatPortalOrderShipToAddress(order) || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Warehouse Contact</td><td style="padding:6px 0;">${escapeHtml(order.contactName || "-")}${order.contactPhone ? ` | ${escapeHtml(order.contactPhone)}` : ""}</td></tr>
                ${confirmation.shippedConfirmationNote ? `<tr><td style="padding:6px 0;font-weight:600;">Shipping Note</td><td style="padding:6px 0;">${escapeHtml(confirmation.shippedConfirmationNote)}</td></tr>` : ""}
            </table>
            <p style="margin:20px 0 8px;font-weight:600;">Order Lines</p>
            <table style="border-collapse:collapse;width:100%;max-width:720px;border:1px solid #e5e7eb;">
                <thead>
                    <tr style="background:#f9fafb;">
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">SKU</th>
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Quantity</th>
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Description</th>
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">UPC</th>
                    </tr>
                </thead>
                <tbody>${linesHtml}</tbody>
            </table>
            ${documentList}
        </div>
    `;
}

function buildPortalReleaseEmailText(order, { ccRecipients = [], pdfDocument = null } = {}) {
    const lines = [
        `Portal order released: ${order.orderCode}`,
        `Company: ${order.accountName}`,
        `Status: ${order.status}`,
        order.poNumber ? `PO Number: ${order.poNumber}` : "",
        order.shippingReference ? `Shipping Reference: ${order.shippingReference}` : "",
        order.requestedShipDate ? `Requested Ship Date: ${order.requestedShipDate}` : "",
        order.contactName ? `Customer Contact: ${order.contactName}${order.contactPhone ? ` | ${order.contactPhone}` : ""}` : "",
        formatPortalOrderShipToAddress(order) ? `Ship To: ${formatPortalOrderShipToAddress(order)}` : "",
        ccRecipients.length ? `CC Recipients: ${ccRecipients.join(", ")}` : "",
        pdfDocument?.fileName ? `Attached PDF: ${pdfDocument.fileName}` : "",
        "",
        "Order Lines:"
    ];

    order.lines.forEach((line) => {
        lines.push(
            `- ${line.sku} | ${formatTrackedQuantity(line.quantity, line.trackingLevel)}${line.description ? ` | ${line.description}` : ""}${line.upc ? ` | UPC ${line.upc}` : ""}`
        );
    });

    return lines.filter((line, index, array) => line || (index > 0 && array[index - 1] !== "")).join("\n");
}

function buildPortalReleaseEmailHtml(order, { ccRecipients = [], pdfDocument = null } = {}) {
    const linesHtml = order.lines.map((line) => `
        <tr>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(line.sku)}</td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(formatTrackedQuantity(line.quantity, line.trackingLevel))}</td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(line.description || "-")}</td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(line.upc || "-")}</td>
        </tr>
    `).join("");

    return `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
            <h2 style="margin:0 0 12px;">Portal Order Released</h2>
            <p style="margin:0 0 16px;">Order <strong>${escapeHtml(order.orderCode)}</strong> for <strong>${escapeHtml(order.accountName)}</strong> was released from the customer portal and is ready for warehouse review.</p>
            <table style="border-collapse:collapse;width:100%;max-width:720px;">
                <tr><td style="padding:6px 0;font-weight:600;">PO Number</td><td style="padding:6px 0;">${escapeHtml(order.poNumber || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Shipping Reference</td><td style="padding:6px 0;">${escapeHtml(order.shippingReference || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Requested Ship Date</td><td style="padding:6px 0;">${escapeHtml(order.requestedShipDate || "-")}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Customer Contact</td><td style="padding:6px 0;">${escapeHtml(order.contactName || "-")}${order.contactPhone ? ` | ${escapeHtml(order.contactPhone)}` : ""}</td></tr>
                <tr><td style="padding:6px 0;font-weight:600;">Ship To</td><td style="padding:6px 0;">${escapeHtml(formatPortalOrderShipToAddress(order) || "-")}</td></tr>
                ${ccRecipients.length ? `<tr><td style="padding:6px 0;font-weight:600;">CC</td><td style="padding:6px 0;">${escapeHtml(ccRecipients.join(", "))}</td></tr>` : ""}
                ${pdfDocument?.fileName ? `<tr><td style="padding:6px 0;font-weight:600;">Attached PDF</td><td style="padding:6px 0;">${escapeHtml(pdfDocument.fileName)}</td></tr>` : ""}
            </table>
            <p style="margin:20px 0 8px;font-weight:600;">Order Lines</p>
            <table style="border-collapse:collapse;width:100%;max-width:720px;border:1px solid #e5e7eb;">
                <thead>
                    <tr style="background:#f9fafb;">
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">SKU</th>
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Quantity</th>
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Description</th>
                        <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">UPC</th>
                    </tr>
                </thead>
                <tbody>${linesHtml}</tbody>
            </table>
        </div>
    `;
}

async function sendPortalOrderReleaseEmail(order, { ccRecipients = [], pdfDocument = null } = {}) {
    if (!hasSystemEmailConfig()) {
        throw httpError(500, "Warehouse email is not configured yet. Set SMTP_HOST, SMTP_PORT, and SMTP_FROM first.");
    }

    const recipients = getPortalOrderReleaseRecipients();
    if (!recipients.length) {
        throw httpError(400, "No warehouse notification email is configured. Set ORDER_RELEASE_TO or SMTP_REPLY_TO first.");
    }

    const normalizedCcRecipients = normalizeEmailList(ccRecipients).filter((email) => !recipients.includes(email));
    const transporter = getSystemMailer("Warehouse email is not configured yet. Set SMTP_HOST, SMTP_PORT, and SMTP_FROM first.");
    await transporter.sendMail({
        from: SMTP_FROM,
        to: recipients.join(", "),
        cc: normalizedCcRecipients.length ? normalizedCcRecipients.join(", ") : undefined,
        replyTo: SMTP_REPLY_TO || undefined,
        subject: `Portal Order Released - ${order.orderCode}`,
        text: buildPortalReleaseEmailText(order, { ccRecipients: normalizedCcRecipients, pdfDocument }),
        html: buildPortalReleaseEmailHtml(order, { ccRecipients: normalizedCcRecipients, pdfDocument }),
        attachments: pdfDocument ? [{
            filename: pdfDocument.fileName,
            content: pdfDocument.fileBuffer,
            contentType: pdfDocument.fileType
        }] : []
    });

    return {
        recipients,
        ccRecipients: normalizedCcRecipients
    };
}

async function sendPortalShipmentConfirmationEmail(client, order, confirmation, { isUpdate = false } = {}) {
    const recipients = await getPortalShipmentRecipients(client, order.accountName);
    if (!recipients.length) {
        throw httpError(400, "No active portal user or company email is available for shipment confirmation.");
    }

    const transporter = getShipmentMailer();
    await transporter.sendMail({
        from: SMTP_FROM,
        to: recipients.join(", "),
        replyTo: SMTP_REPLY_TO || undefined,
        subject: `${isUpdate ? "Shipment Confirmation Updated" : "Shipment Confirmed"} - ${order.orderCode}`,
        text: buildPortalShipmentEmailText(order, confirmation, { isUpdate }),
        html: buildPortalShipmentEmailHtml(order, confirmation, { isUpdate }),
        attachments: confirmation.documents.map((document) => ({
            filename: document.fileName,
            content: document.fileBuffer,
            contentType: document.fileType
        }))
    });

    return recipients;
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
    const notificationRecipients = await sendPortalShipmentConfirmationEmail(
        client,
        updatedOrder,
        {
            ...confirmation,
            confirmedShipDate,
            shippedCarrierName,
            shippedTrackingReference,
            shippedConfirmationNote
        },
        { isUpdate: !transitionToShipped }
    );
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
            notificationRecipients.length ? `Email sent to ${formatCount(notificationRecipients.length, "recipient")}` : "",
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

function mapPortalOrders(orderRows, lineRows, documentRows = [], downloadPathPrefix = "/api/admin/portal-order-documents", locationSummaries = new Map(), allocationSummaries = new Map()) {
    const linesByOrderId = new Map();
    lineRows.forEach((row) => {
        const key = String(row.order_id);
        const locationKey = `${normalizeText(row.account_name)}::${normalizeText(row.sku)}`;
        if (!linesByOrderId.has(key)) linesByOrderId.set(key, []);
        linesByOrderId.get(key).push(mapPortalOrderLineRow(row, locationSummaries.get(locationKey), allocationSummaries.get(String(row.id))));
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

async function savePortalInboundForAccount(
    client,
    accountName,
    rawInbound,
    {
        portalAccessId = null,
        activityTitlePrefix = "portal",
        activityActor = ""
    } = {}
) {
    const normalizedAccount = normalizeText(accountName);
    const inbound = sanitizePortalInboundInput(rawInbound, normalizedAccount);

    if (!inbound.referenceNumber || !inbound.expectedDate || !inbound.contactName) {
        throw httpError(400, "Reference number, expected date, and contact name are required.");
    }
    if (!inbound.lines.length) {
        throw httpError(400, "Add at least one line before submitting.");
    }
    for (const line of inbound.lines) {
        await assertPortalInboundSkuAllowed(client, normalizedAccount, line.sku);
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
            normalizedAccount,
            portalAccessId,
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

    const savedInbound = (await getPortalInboundsForAccount(normalizedAccount, client)).find((entry) => entry.id === inboundId);
    await insertActivity(
        client,
        "receipt",
        `Submitted ${activityTitlePrefix} purchase order ${savedInbound.inboundCode}`,
        [
            savedInbound.accountName,
            `${formatCount(savedInbound.lines.length, "line")}`,
            `Ref ${savedInbound.referenceNumber}`,
            activityActor || ""
        ].filter(Boolean).join(" | ")
    );
    return savedInbound;
}

async function savePortalInbound(client, accessRow, rawInbound) {
    const access = mapPortalAccessRow(accessRow);
    return savePortalInboundForAccount(client, access.accountName, rawInbound, {
        portalAccessId: accessRow.id,
        activityTitlePrefix: "portal",
        activityActor: "Company portal"
    });
}

async function saveWarehousePortalInbound(client, accountName, rawInbound, appUser = null) {
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    await upsertOwnerMaster(client, accountName);
    return savePortalInboundForAccount(client, accountName, rawInbound, {
        portalAccessId: null,
        activityTitlePrefix: "warehouse purchase order",
        activityActor: actor
    });
}

async function updateWarehousePortalInbound(client, inboundId, accountName, rawInbound, appUser = null) {
    const normalizedAccount = normalizeText(accountName);
    const currentInbound = await getPortalInboundById(client, inboundId);
    if (!currentInbound) {
        throw httpError(404, "That purchase order could not be found.");
    }
    if (normalizeText(currentInbound.accountName) !== normalizedAccount) {
        throw httpError(400, "Purchase order company cannot be changed.");
    }
    if (currentInbound.status !== "SUBMITTED") {
        throw httpError(400, "Only open submitted purchase orders can be edited.");
    }

    const inbound = sanitizePortalInboundInput(rawInbound, normalizedAccount);
    if (!inbound.referenceNumber || !inbound.expectedDate || !inbound.contactName) {
        throw httpError(400, "Reference number, expected date, and contact name are required.");
    }
    if (!inbound.lines.length) {
        throw httpError(400, "Add at least one line before submitting.");
    }
    for (const line of inbound.lines) {
        await assertPortalInboundSkuAllowed(client, normalizedAccount, line.sku);
    }

    await client.query(
        `
            update portal_inbounds
            set
                reference_number = $2,
                carrier_name = $3,
                expected_date = $4,
                contact_name = $5,
                contact_phone = $6,
                notes = $7,
                updated_at = now()
            where id = $1
        `,
        [
            inboundId,
            inbound.referenceNumber,
            inbound.carrierName,
            inbound.expectedDate,
            inbound.contactName,
            inbound.contactPhone,
            inbound.notes
        ]
    );
    await client.query("delete from portal_inbound_lines where inbound_id = $1", [inboundId]);
    for (const [index, line] of inbound.lines.entries()) {
        await client.query(
            `
                insert into portal_inbound_lines (inbound_id, line_number, sku, expected_quantity)
                values ($1, $2, $3, $4)
            `,
            [inboundId, index + 1, line.sku, line.quantity]
        );
    }

    const updatedInbound = await getPortalInboundById(client, inboundId);
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    await insertActivity(
        client,
        "receipt",
        `Updated warehouse purchase order ${updatedInbound.inboundCode}`,
        [
            updatedInbound.accountName,
            `${formatCount(updatedInbound.lines.length, "line")}`,
            `Ref ${updatedInbound.referenceNumber}`,
            actor
        ].filter(Boolean).join(" | ")
    );
    return updatedInbound;
}

async function updateAdminPortalInboundStatus(client, inboundId, nextStatus, appUser = null) {
    const inboundResult = await client.query("select * from portal_inbounds where id = $1 limit 1", [inboundId]);
    if (inboundResult.rowCount !== 1) {
        throw httpError(404, "That purchase order could not be found.");
    }

    const currentInbound = await getPortalInboundById(client, inboundId);
    if (!currentInbound) {
        throw httpError(404, "That purchase order could not be found.");
    }
    if (currentInbound.status === nextStatus) {
        return currentInbound;
    }

    const allowedTransitions = {
        SUBMITTED: ["RECEIVED", "CANCELLED"]
    };
    const allowedNext = allowedTransitions[currentInbound.status] || [];
    if (!allowedNext.includes(nextStatus)) {
        throw httpError(400, `Purchase orders in ${currentInbound.status} can only move to ${allowedNext.join(" or ") || "their next allowed status"}.`);
    }

    await client.query(
        `
            update portal_inbounds
            set
                status = $2,
                received_at = case when $2 = 'RECEIVED' then coalesce(received_at, now()) else received_at end,
                updated_at = now()
            where id = $1
        `,
        [inboundId, nextStatus]
    );

    const updatedInbound = await getPortalInboundById(client, inboundId);
    const actor = appUser?.full_name || appUser?.email || "Warehouse";
    await insertActivity(
        client,
        "receipt",
        `Marked purchase order ${updatedInbound.inboundCode} ${nextStatus.toLowerCase()}`,
        `${updatedInbound.accountName} | ${formatCount(updatedInbound.lines.length, "line")} | ${actor}`
    );
    return updatedInbound;
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
    const allocationResult = await client.query(
        `
            select *
            from portal_order_allocations
            where order_id = $1
            order by order_line_id asc, id asc
        `,
        [order.id]
    );

    if (allocationResult.rowCount > 0) {
        for (const allocation of allocationResult.rows) {
            const inventoryLineId = allocation.inventory_line_id ? String(allocation.inventory_line_id) : "";
            const requiredQuantity = Number(allocation.allocated_quantity) || 0;
            if (!inventoryLineId || requiredQuantity <= 0) continue;

            const inventoryResult = await client.query("select * from inventory_lines where id = $1 limit 1", [inventoryLineId]);
            if (inventoryResult.rowCount !== 1) {
                throw httpError(
                    409,
                    `Order ${order.orderCode} cannot be marked shipped because the allocated inventory line for ${allocation.sku} is no longer available.`
                );
            }

            const inventoryLine = inventoryResult.rows[0];
            const currentQuantity = Number(inventoryLine.quantity) || 0;
            if (currentQuantity < requiredQuantity) {
                throw httpError(
                    409,
                    `Order ${order.orderCode} cannot be marked shipped because ${allocation.sku}${allocation.lot_number ? ` lot ${allocation.lot_number}` : ""} only has ${formatTrackedQuantity(currentQuantity, inventoryLine.tracking_level)} left on hand.`
                );
            }

            await setInventoryQuantity(client, inventoryLine.id, currentQuantity - requiredQuantity);
        }
        return;
    }

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
    const entry = sanitizeInventoryLineInput(item);
    if (!entry) return;

    const existing = await client.query(
        `
            select *
            from inventory_lines
            where account_name = $1
              and location = $2
              and sku = $3
              and lot_number = $4
              and expiration_date = $5
            limit 1
        `,
        [entry.accountName, entry.location, entry.sku, entry.lotNumber || "", entry.expirationDate || ""]
    );

    if (existing.rowCount === 1) {
        await client.query(
            `
                update inventory_lines
                set
                    upc = case
                        when coalesce(upc, '') = '' and $2 <> '' then $2
                        else upc
                    end,
                    tracking_level = $3,
                    quantity = quantity + $4,
                    updated_at = now()
                where id = $1
            `,
            [existing.rows[0].id, entry.upc || "", entry.trackingLevel || "UNIT", entry.quantity]
        );
        return;
    }

    await client.query(
        `
            insert into inventory_lines (
                account_name, location, sku, upc, lot_number, expiration_date, tracking_level, quantity
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
            entry.accountName,
            entry.location,
            entry.sku,
            entry.upc || "",
            entry.lotNumber || "",
            entry.expirationDate || "",
            entry.trackingLevel || "UNIT",
            entry.quantity
        ]
    );
}

async function removeInventoryContribution(client, item) {
    const accountName = normalizeText(item?.accountName);
    const location = normalizeText(item?.location);
    const sku = normalizeText(item?.sku);
    const lotNumber = normalizeText(item?.lotNumber || item?.lot_number || item?.lot || "");
    const expirationDate = normalizeDateOnly(item?.expirationDate || item?.expiration_date || item?.expiryDate || item?.expiry_date || "");
    const quantity = toPositiveInt(item?.quantity);
    if (!accountName || !location || !sku || !quantity) return;

    const result = await client.query(
        `
            select *
            from inventory_lines
            where account_name = $1
              and location = $2
              and sku = $3
              and lot_number = $4
              and expiration_date = $5
            limit 1
        `,
        [accountName, location, sku, lotNumber, expirationDate]
    );

    if (result.rowCount !== 1) {
        throw httpError(409, `Pallet inventory for ${accountName} / ${sku} at ${location}${lotNumber ? ` lot ${lotNumber}` : ""} is missing and cannot be updated safely.`);
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
    const explicitFeatureFlags = entry.featureFlagsConfigured
        ? JSON.stringify(resolveCompanyFeatureFlags(entry.featureFlags, { legacyMode: false }))
        : null;
    const insertFeatureFlags = explicitFeatureFlags || JSON.stringify(buildDefaultNewCompanyFeatureFlags());
    const featureFlagsUpdatedAt = entry.featureFlagsConfigured
        ? (entry.featureFlagsUpdatedAt || new Date().toISOString())
        : null;
    const featureFlagsUpdatedBy = entry.featureFlagsConfigured
        ? normalizeFreeText(entry.featureFlagsUpdatedBy || "system")
        : "";

    await client.query(
        `
            insert into owner_accounts (
                name, note, legal_name, account_code, contact_name, contact_title,
                email, phone, mobile, website, billing_email, ap_email, portal_login_email,
                address1, address2, city, state, postal_code, country, is_active,
                feature_flags, feature_flags_updated_at, feature_flags_updated_by
            )
            values (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20,
                $21::jsonb, $22, $23
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
                feature_flags = case when $24 = true then excluded.feature_flags else owner_accounts.feature_flags end,
                feature_flags_updated_at = case when $24 = true then excluded.feature_flags_updated_at else owner_accounts.feature_flags_updated_at end,
                feature_flags_updated_by = case when $24 = true then excluded.feature_flags_updated_by else owner_accounts.feature_flags_updated_by end,
                updated_at = now()
        `,
        [
            entry.name, entry.note, entry.legalName, entry.accountCode, entry.contactName, entry.contactTitle,
            entry.email, entry.phone, entry.mobile, entry.website, entry.billingEmail, entry.apEmail, entry.portalLoginEmail,
            entry.address1, entry.address2, entry.city, entry.state, entry.postalCode, entry.country, entry.isActive,
            insertFeatureFlags, featureFlagsUpdatedAt, featureFlagsUpdatedBy, entry.featureFlagsConfigured === true
        ]
    );
}

async function upsertCompanyPartner(client, partnerInput) {
    const entry = sanitizeCompanyPartnerInput(partnerInput);
    if (!entry?.accountName || !entry?.partnerType || !entry?.name) return;
    const partnerId = toPositiveInt(entry.id);

    if (partnerId) {
        const updated = await client.query(
            `
                update company_partner_accounts
                set partner_type = $2,
                    name = $3,
                    account_code = $4,
                    contact_name = $5,
                    contact_title = $6,
                    email = $7,
                    phone = $8,
                    mobile = $9,
                    website = $10,
                    address1 = $11,
                    address2 = $12,
                    city = $13,
                    state = $14,
                    postal_code = $15,
                    country = $16,
                    is_active = $17,
                    note = $18,
                    updated_at = now()
                where id = $19 and account_name = $1
            `,
            [
                entry.accountName, entry.partnerType, entry.name, entry.accountCode, entry.contactName, entry.contactTitle,
                entry.email, entry.phone, entry.mobile, entry.website, entry.address1, entry.address2, entry.city, entry.state,
                entry.postalCode, entry.country, entry.isActive, entry.note, partnerId
            ]
        );
        if (updated.rowCount) return;
    }

    await client.query(
        `
            insert into company_partner_accounts (
                account_name, partner_type, name, account_code, contact_name, contact_title,
                email, phone, mobile, website, address1, address2, city, state,
                postal_code, country, is_active, note
            )
            values (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17, $18
            )
            on conflict (account_name, partner_type, name)
            do update set
                account_code = excluded.account_code,
                contact_name = excluded.contact_name,
                contact_title = excluded.contact_title,
                email = excluded.email,
                phone = excluded.phone,
                mobile = excluded.mobile,
                website = excluded.website,
                address1 = excluded.address1,
                address2 = excluded.address2,
                city = excluded.city,
                state = excluded.state,
                postal_code = excluded.postal_code,
                country = excluded.country,
                is_active = excluded.is_active,
                note = excluded.note,
                updated_at = now()
        `,
        [
            entry.accountName, entry.partnerType, entry.name, entry.accountCode, entry.contactName, entry.contactTitle,
            entry.email, entry.phone, entry.mobile, entry.website, entry.address1, entry.address2, entry.city, entry.state,
            entry.postalCode, entry.country, entry.isActive, entry.note
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
                case_length, case_width, case_height, lot_tracked, expiration_tracked
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
                lot_tracked = excluded.lot_tracked,
                expiration_tracked = excluded.expiration_tracked,
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
            entry.caseHeight,
            entry.lotTracked,
            entry.expirationTracked
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
                case_length, case_width, case_height, lot_tracked, expiration_tracked
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
                lot_tracked = excluded.lot_tracked,
                expiration_tracked = excluded.expiration_tracked,
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
            entry.caseHeight,
            entry.lotTracked,
            entry.expirationTracked
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
        caseHeight: item.caseHeight,
        lotTracked: item.lotTracked,
        expirationTracked: item.expirationTracked
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
            caseHeight: mergedEntry.caseHeight ?? targetMaster.caseHeight ?? null,
            lotTracked: mergedEntry.lotTracked ?? targetMaster.lotTracked ?? false,
            expirationTracked: mergedEntry.expirationTracked ?? targetMaster.expirationTracked ?? false
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
        const targetByLocation = new Map(targetLines.rows.map((row) => [`${row.location}::${row.lot_number || ""}::${normalizeDateOnly(row.expiration_date)}`, row]));

        for (const line of originalLines.rows) {
            const existingTarget = targetByLocation.get(`${line.location}::${line.lot_number || ""}::${normalizeDateOnly(line.expiration_date)}`);
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

function buildInventoryIdentityKey(entry) {
    return [
        normalizeText(entry?.accountName || ""),
        normalizeText(entry?.location || ""),
        normalizeText(entry?.sku || ""),
        normalizeText(entry?.lotNumber || entry?.lot_number || entry?.lot || ""),
        normalizeDateOnly(entry?.expirationDate || entry?.expiration_date || entry?.expiryDate || entry?.expiry_date || "")
    ].join("::");
}

function sanitizeBulkInventoryWorksheetRowInput(line, fallbackAccountName = "") {
    const id = toPositiveInt(line?.id);
    const accountName = normalizeText(line?.accountName || line?.owner || line?.vendor || line?.customer || fallbackAccountName);
    const location = normalizeText(line?.location);
    const sku = normalizeText(line?.sku);
    const upc = normalizeText(line?.upc || "");
    const lotNumber = normalizeText(line?.lotNumber || line?.lot_number || line?.lot || "");
    const expirationDate = normalizeDateOnly(line?.expirationDate || line?.expiration_date || line?.expiryDate || line?.expiry_date || "");
    const trackingLevel = normalizeTrackingLevel(line?.trackingLevel);
    const rawQuantity = line?.quantity;
    const quantity = rawQuantity === "" || rawQuantity == null ? null : toNonNegativeInt(rawQuantity);
    const isBlank = !id
        && !location
        && !sku
        && !upc
        && !lotNumber
        && !expirationDate
        && (quantity == null || quantity === 0);

    return {
        id,
        accountName,
        location,
        sku,
        upc,
        lotNumber,
        expirationDate,
        trackingLevel,
        quantity,
        isBlank
    };
}

async function saveBulkInventoryWorksheet(client, accountName, rawRows, appUser = null) {
    const normalizedAccount = normalizeText(accountName);
    if (!normalizedAccount) {
        throw httpError(400, "Choose a company before saving bulk inventory changes.");
    }
    if (!Array.isArray(rawRows)) {
        throw httpError(400, "Worksheet rows are required.");
    }

    const rows = rawRows
        .map((row) => sanitizeBulkInventoryWorksheetRowInput(row, normalizedAccount))
        .filter((row) => !row.isBlank);

    if (!rows.length) {
        return { processed: 0, added: 0, updated: 0, deleted: 0 };
    }

    const existingResult = await client.query(
        "select * from inventory_lines where account_name = $1 order by location asc, sku asc, id asc",
        [normalizedAccount]
    );
    const existingById = new Map(existingResult.rows.map((row) => [String(row.id), row]));
    const finalIdentityMap = new Map();

    rows.forEach((row, index) => {
        if (row.id) {
            const existing = existingById.get(String(row.id));
            if (!existing) {
                throw httpError(404, `Worksheet row ${index + 1} no longer matches a saved inventory line for ${normalizedAccount}. Refresh and try again.`);
            }
        }

        if (row.quantity === 0) {
            if (!row.id) return;
            return;
        }

        if (!row.location || !row.sku || row.quantity == null) {
            throw httpError(400, `Worksheet row ${index + 1} must include Location, SKU, and Qty.`);
        }

        const identityKey = buildInventoryIdentityKey({ ...row, accountName: normalizedAccount });
        if (finalIdentityMap.has(identityKey)) {
            throw httpError(409, `Worksheet row ${index + 1} duplicates another inventory line with the same location, SKU, lot, and expiration date.`);
        }
        finalIdentityMap.set(identityKey, String(row.id || `new-${index}`));
    });

    let added = 0;
    let updated = 0;
    let deleted = 0;

    try {
        for (const row of rows) {
            if (row.id) {
                const existing = existingById.get(String(row.id));
                if (!existing) {
                    throw httpError(404, "One of the inventory worksheet rows could not be found anymore. Refresh and try again.");
                }
                if (row.quantity === 0) {
                    await client.query("delete from inventory_lines where id = $1 and account_name = $2", [row.id, normalizedAccount]);
                    deleted += 1;
                    continue;
                }
            } else if (row.quantity === 0) {
                continue;
            }

            await assertLocationCompatibleForOwner(client, normalizedAccount, row.location);
            await upsertLocationMaster(client, row.location);
            await upsertItemMaster(client, {
                accountName: normalizedAccount,
                sku: row.sku,
                upc: row.upc,
                trackingLevel: row.trackingLevel
            });

            if (row.id) {
                await client.query(
                    `
                        update inventory_lines
                        set
                            location = $2,
                            sku = $3,
                            upc = $4,
                            lot_number = $5,
                            expiration_date = $6,
                            tracking_level = $7,
                            quantity = $8,
                            updated_at = now()
                        where id = $1
                          and account_name = $9
                    `,
                    [
                        row.id,
                        row.location,
                        row.sku,
                        row.upc || "",
                        row.lotNumber || "",
                        row.expirationDate || "",
                        row.trackingLevel || "UNIT",
                        row.quantity,
                        normalizedAccount
                    ]
                );
                updated += 1;
            } else {
                await client.query(
                    `
                        insert into inventory_lines (
                            account_name, location, sku, upc, lot_number, expiration_date, tracking_level, quantity
                        )
                        values ($1, $2, $3, $4, $5, $6, $7, $8)
                    `,
                    [
                        normalizedAccount,
                        row.location,
                        row.sku,
                        row.upc || "",
                        row.lotNumber || "",
                        row.expirationDate || "",
                        row.trackingLevel || "UNIT",
                        row.quantity
                    ]
                );
                added += 1;
            }
        }
    } catch (error) {
        if (error?.code === "23505") {
            throw httpError(409, "Bulk inventory save found duplicate location / SKU / lot / expiration rows. Merge duplicates and try again.");
        }
        throw error;
    }

    const processed = added + updated + deleted;
    if (processed > 0) {
        const actor = normalizeFreeText(appUser?.full_name || appUser?.email || "");
        await insertActivity(
            client,
            "inventory",
            `Bulk updated inventory worksheet for ${normalizedAccount}`,
            [
                `${processed} row${processed === 1 ? "" : "s"} processed`,
                added ? `${added} added` : "",
                updated ? `${updated} updated` : "",
                deleted ? `${deleted} removed` : "",
                actor || ""
            ].filter(Boolean).join(" | ")
        );
    }

    return { processed, added, updated, deleted };
}

async function insertActivity(client, type, title, details) {
    const result = await client.query(
        "insert into activity_log (type, title, details) values ($1, $2, $3) returning *",
        [type, title, details]
    );
    return result.rows[0] ? mapActivityRow(result.rows[0]) : null;
}

async function findInventoryLine(client, accountName, location, skuOrUpc, { lotNumber = "", expirationDate = "" } = {}) {
    const normalizedLot = normalizeText(lotNumber || "");
    const normalizedExpirationDate = normalizeDateOnly(expirationDate || "");
    const skuParams = [accountName, location, skuOrUpc];
    let identitySql = "";

    if (normalizedLot || normalizedExpirationDate) {
        skuParams.push(normalizedLot, normalizedExpirationDate);
        identitySql = ` and lot_number = $4 and expiration_date = $5`;
    }

    const skuMatch = await client.query(
        `select * from inventory_lines where account_name = $1 and location = $2 and sku = $3${identitySql} order by lot_number asc, expiration_date asc, id asc limit 2`,
        skuParams
    );
    if (skuMatch.rowCount === 1) {
        return skuMatch.rows[0];
    }
    if (skuMatch.rowCount > 1) {
        throw httpError(400, "Multiple lot or expiration rows matched that SKU in the selected location. Use a lot-specific adjustment.");
    }

    const upcParams = [accountName, location, skuOrUpc];
    if (normalizedLot || normalizedExpirationDate) {
        upcParams.push(normalizedLot, normalizedExpirationDate);
    }
    const upcMatches = await client.query(
        `select * from inventory_lines where account_name = $1 and location = $2 and upc = $3${identitySql} order by sku asc, lot_number asc, expiration_date asc limit 2`,
        upcParams
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
        const key = `${line.accountName}::${line.location}::${line.sku}::${line.lotNumber || ""}::${line.expirationDate || ""}`;
        const current = grouped.get(key) || {
            accountName: line.accountName,
            location: line.location,
            sku: line.sku,
            upc: line.upc,
            lotNumber: line.lotNumber || "",
            expirationDate: line.expirationDate || "",
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
    const lotNumber = normalizeText(line?.lotNumber || line?.lot_number || line?.lot || "");
    const expirationDate = normalizeDateOnly(line?.expirationDate || line?.expiration_date || line?.expiryDate || line?.expiry_date || "");
    const quantity = toPositiveInt(line?.quantity);
    const trackingLevel = normalizeTrackingLevel(line?.trackingLevel);
    if (!accountName || !location || !sku || !quantity) return null;
    return {
        accountName,
        location,
        sku,
        upc,
        lotNumber,
        expirationDate,
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
            caseHeight: null,
            lotTracked: false,
            expirationTracked: false
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
        current.lotTracked = current.lotTracked || item.lotTracked === true;
        current.expirationTracked = current.expirationTracked || item.expirationTracked === true;

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
    const hasFeatureFlags = typeof item === "object"
        && item !== null
        && (Object.prototype.hasOwnProperty.call(item, "featureFlags")
            || Object.prototype.hasOwnProperty.call(item, "feature_flags")
            || Object.prototype.hasOwnProperty.call(item, "features"));
    const featureFlags = hasFeatureFlags
        ? sanitizeCompanyFeatureFlagsInput(item?.featureFlags || item?.feature_flags || item?.features || {})
        : null;
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
        featureFlags,
        featureFlagsConfigured: hasFeatureFlags,
        featureFlagsUpdatedAt: typeof item === "string" ? null : (typeof item?.featureFlagsUpdatedAt === "string" ? item.featureFlagsUpdatedAt : (typeof item?.feature_flags_updated_at === "string" ? item.feature_flags_updated_at : null)),
        featureFlagsUpdatedBy: normalizeFreeText(typeof item === "string" ? "" : item?.featureFlagsUpdatedBy || item?.feature_flags_updated_by),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function normalizeCompanyPartnerType(value) {
    const normalized = normalizeText(value || "");
    return normalized === "VENDOR" ? "VENDOR" : "CUSTOMER";
}

function sanitizeCompanyPartnerInput(item) {
    const accountName = normalizeText(item?.accountName || item?.account_name || item?.owner || item?.company || item?.customerAccount || "");
    const partnerType = normalizeCompanyPartnerType(item?.partnerType || item?.partner_type || item?.type);
    const name = normalizeText(item?.name || item?.partnerName || item?.partner_name || item?.customer || item?.vendor);
    if (!accountName || !partnerType || !name) return null;
    return {
        id: item?.id != null ? String(item.id) : "",
        accountName,
        partnerType,
        name,
        accountCode: normalizeText(item?.accountCode || item?.account_code || item?.code),
        contactName: normalizeFreeText(item?.contactName || item?.contact_name),
        contactTitle: normalizeFreeText(item?.contactTitle || item?.contact_title),
        email: normalizeEmail(item?.email),
        phone: normalizeFreeText(item?.phone),
        mobile: normalizeFreeText(item?.mobile || item?.cell),
        website: normalizeFreeText(item?.website),
        address1: normalizeFreeText(item?.address1 || item?.address_1),
        address2: normalizeFreeText(item?.address2 || item?.address_2),
        city: normalizeFreeText(item?.city),
        state: normalizeFreeText(item?.state || item?.province),
        postalCode: normalizeText(item?.postalCode || item?.postal_code || item?.zip),
        country: normalizeFreeText(item?.country),
        isActive: item?.isActive !== false,
        note: normalizeFreeText(item?.note),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
    };
}

function sanitizeStoreIntegrationSettingsInput(provider, settings = {}, rawInput = {}) {
    const normalizedProvider = normalizeStoreIntegrationProvider(provider);
    const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};

    if (normalizedProvider === SFTP_SYNC_PROVIDER) {
        const ordersFolder = normalizeRemoteFolderPath(source.ordersFolder || source.orders_folder || rawInput?.ordersFolder || rawInput?.orders_folder || "");
        const inboundsFolder = normalizeRemoteFolderPath(source.inboundsFolder || source.inbounds_folder || rawInput?.inboundsFolder || rawInput?.inbounds_folder || "");
        const archiveFolder = normalizeRemoteFolderPath(source.archiveFolder || source.archive_folder || rawInput?.archiveFolder || rawInput?.archive_folder || "");
        return {
            port: toPositiveInt(source.port || rawInput?.port) || SFTP_DEFAULT_PORT,
            username: normalizeFreeText(source.username || source.userName || source.user_name || rawInput?.username || rawInput?.userName || rawInput?.user_name || ""),
            ordersFolder,
            inboundsFolder,
            shipmentsFolder: normalizeRemoteFolderPath(source.shipmentsFolder || source.shipments_folder || rawInput?.shipmentsFolder || rawInput?.shipments_folder || ""),
            receiptsFolder: normalizeRemoteFolderPath(source.receiptsFolder || source.receipts_folder || rawInput?.receiptsFolder || rawInput?.receipts_folder || ""),
            inventoryFolder: normalizeRemoteFolderPath(source.inventoryFolder || source.inventory_folder || rawInput?.inventoryFolder || rawInput?.inventory_folder || ""),
            archiveFolder: archiveFolder || ((ordersFolder || inboundsFolder) ? SFTP_DEFAULT_ARCHIVE_FOLDER : "")
        };
    }

    return {};
}

function sanitizeStoreIntegrationInput(item) {
    const provider = normalizeStoreIntegrationProvider(item?.provider || item?.platform || item?.type);
    const settings = sanitizeStoreIntegrationSettingsInput(provider, item?.settings, item);
    return {
        integrationId: toPositiveInt(item?.integrationId || item?.id),
        accountName: normalizeText(item?.accountName || item?.owner || item?.vendor || item?.customer),
        provider,
        integrationName: normalizeFreeText(item?.integrationName || item?.name || item?.label),
        storeIdentifier: normalizeStoreIdentifierForProvider(
            provider,
            item?.storeIdentifier || item?.store || item?.storeUrl || item?.url || item?.shopDomain || item?.shop_domain
        ),
        accessToken: typeof item?.accessToken === "string" ? item.accessToken.trim() : "",
        authClientId: provider === SHOPIFY_SYNC_PROVIDER
            ? normalizeFreeText(item?.authClientId || item?.clientId || item?.client_id || "")
            : "",
        authClientSecret: provider === SHOPIFY_SYNC_PROVIDER
            ? normalizeFreeText(item?.authClientSecret || item?.clientSecret || item?.client_secret || "")
            : "",
        settings,
        importStatus: STORE_INTEGRATION_IMPORT_STATUSES.includes(normalizeText(item?.importStatus || item?.defaultOrderStatus || "DRAFT"))
            ? normalizeText(item?.importStatus || item?.defaultOrderStatus || "DRAFT")
            : "DRAFT",
        isActive: item?.isActive !== false,
        syncSchedule: normalizeStoreIntegrationSyncSchedule(item?.syncSchedule || item?.schedule || item?.autoSync || "MANUAL")
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
        lotTracked: toBooleanFlag(item?.lotTracked ?? item?.lot_tracked ?? item?.trackLot ?? item?.track_lot, false),
        expirationTracked: toBooleanFlag(item?.expirationTracked ?? item?.expiration_tracked ?? item?.trackExpiration ?? item?.track_expiration ?? item?.expiryTracked ?? item?.expiry_tracked, false),
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
        lotNumber: row.lot_number || "",
        expirationDate: normalizeDateOnly(row.expiration_date),
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
    const { featureFlags, legacyMode } = extractOwnerFeatureFlags(row);
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
        featureFlags,
        featureFlagsInherited: legacyMode,
        featureFlagsUpdatedAt: row.feature_flags_updated_at ? new Date(row.feature_flags_updated_at).toISOString() : null,
        featureFlagsUpdatedBy: row.feature_flags_updated_by || "",
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapCompanyPartnerRow(row) {
    return {
        id: String(row.id),
        accountName: row.account_name,
        partnerType: normalizeCompanyPartnerType(row.partner_type),
        name: row.name,
        accountCode: row.account_code || "",
        contactName: row.contact_name || "",
        contactTitle: row.contact_title || "",
        email: row.email || "",
        phone: row.phone || "",
        mobile: row.mobile || "",
        website: row.website || "",
        address1: row.address1 || row.address_1 || "",
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
        lotTracked: row.lot_tracked === true,
        expirationTracked: row.expiration_tracked === true,
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
    const { featureFlags, legacyMode } = extractOwnerFeatureFlags(row);
    return {
        id: String(row.id),
        accountName: row.account_name,
        email: row.email || "",
        isActive: row.is_active === true,
        featureFlags,
        featureFlagsInherited: legacyMode,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function mapStoreIntegrationRow(row) {
    return {
        id: String(row.id),
        accountName: row.account_name,
        provider: normalizeStoreIntegrationProvider(row.provider),
        integrationName: row.integration_name || "",
        storeIdentifier: row.store_identifier || "",
        settings: sanitizeStoreIntegrationSettingsInput(row.provider, row.settings || {}),
        importStatus: STORE_INTEGRATION_IMPORT_STATUSES.includes(normalizeText(row.import_status || "DRAFT"))
            ? normalizeText(row.import_status || "DRAFT")
            : "DRAFT",
        isActive: row.is_active === true,
        syncSchedule: normalizeStoreIntegrationSyncSchedule(row.sync_schedule || "MANUAL"),
        nextScheduledSyncAt: row.next_scheduled_sync_at ? new Date(row.next_scheduled_sync_at).toISOString() : null,
        hasAccessToken: !!String(row.access_token || "").trim(),
        accessTokenMasked: maskSecretTail(row.access_token || ""),
        hasAuthClientCredentials: !!(String(row.auth_client_id || "").trim() && String(row.auth_client_secret || "").trim()),
        authClientIdMasked: maskSecretTail(row.auth_client_id || ""),
        accessTokenExpiresAt: row.access_token_expires_at ? new Date(row.access_token_expires_at).toISOString() : null,
        lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
        lastSyncStatus: STORE_INTEGRATION_SYNC_STATUSES.includes(normalizeText(row.last_sync_status || "IDLE"))
            ? normalizeText(row.last_sync_status || "IDLE")
            : "IDLE",
        lastSyncMessage: row.last_sync_message || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
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
        eachLength: row.each_length == null ? null : Number(row.each_length),
        eachWidth: row.each_width == null ? null : Number(row.each_width),
        eachHeight: row.each_height == null ? null : Number(row.each_height),
        caseLength: row.case_length == null ? null : Number(row.case_length),
        caseWidth: row.case_width == null ? null : Number(row.case_width),
        caseHeight: row.case_height == null ? null : Number(row.case_height),
        imageUrl: row.image_url || "",
        lotTracked: row.lot_tracked === true,
        expirationTracked: row.expiration_tracked === true,
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

function mapPortalOrderLineRow(row, locationSummary = null, allocationSummary = null) {
    const normalizedLocations = Array.isArray(locationSummary?.locations)
        ? locationSummary.locations.map((entry) => ({
            location: entry.location || "",
            quantity: Number(entry.quantity) || 0,
            trackingLevel: normalizeTrackingLevel(entry.trackingLevel || locationSummary?.trackingLevel || row.item_tracking_level || "UNIT"),
            lotNumber: entry.lotNumber || "",
            expirationDate: normalizeDateOnly(entry.expirationDate)
        })).filter((entry) => entry.location)
        : [];
    const allocatedLocations = Array.isArray(allocationSummary?.locations)
        ? allocationSummary.locations.map((entry) => ({
            inventoryLineId: entry.inventoryLineId || "",
            location: entry.location || "",
            quantity: Number(entry.quantity) || 0,
            trackingLevel: normalizeTrackingLevel(entry.trackingLevel || row.item_tracking_level || "UNIT"),
            lotNumber: entry.lotNumber || "",
            expirationDate: normalizeDateOnly(entry.expirationDate)
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
        lotTracked: row.item_lot_tracked === true,
        expirationTracked: row.item_expiration_tracked === true,
        onHandQuantity: Number(locationSummary?.onHandQuantity) || 0,
        availableQuantity: Number(locationSummary?.availableQuantity) || 0,
        allocatedQuantity: Number(allocationSummary?.allocatedQuantity) || 0,
        pickLocations: allocatedLocations.length ? allocatedLocations : normalizedLocations,
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
        receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
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

function normalizePortalInboundStatus(value) {
    const normalized = normalizeText(value);
    return ["SUBMITTED", "RECEIVED", "CANCELLED"].includes(normalized) ? normalized : "";
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

function toNonNegativeInt(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toPositiveNumber(value) {
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toBooleanFlag(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const text = String(value || "").trim().toLowerCase();
    if (!text) return fallback;
    if (["1", "true", "yes", "y", "on"].includes(text)) return true;
    if (["0", "false", "no", "n", "off"].includes(text)) return false;
    return fallback;
}

function isSuperAdminUser(user) {
    return normalizeText(user?.role || "") === "SUPER_ADMIN";
}

function assertSuperAdminAccess(user) {
    if (!isSuperAdminUser(user)) {
        throw httpError(403, "Super user access is required for that action.");
    }
}

function buildDefaultNewCompanyFeatureFlags() {
    return { ...DEFAULT_NEW_COMPANY_FEATURE_FLAGS };
}

function buildLegacyCompanyFeatureFlags() {
    return { ...LEGACY_COMPANY_FEATURE_FLAGS };
}

function sanitizeCompanyFeatureFlagsInput(rawFlags) {
    if (!rawFlags || typeof rawFlags !== "object" || Array.isArray(rawFlags)) {
        return {};
    }

    return COMPANY_FEATURE_CATALOG.reduce((accumulator, feature) => {
        const rawValue = rawFlags[feature.key];
        accumulator[feature.key] = toBooleanFlag(rawValue, false);
        return accumulator;
    }, {});
}

function resolveCompanyFeatureFlags(rawFlags, { legacyMode = false } = {}) {
    const baseFlags = legacyMode ? buildLegacyCompanyFeatureFlags() : buildDefaultNewCompanyFeatureFlags();
    const merged = {
        ...baseFlags,
        ...sanitizeCompanyFeatureFlagsInput(rawFlags)
    };
    if (!merged[COMPANY_FEATURE_KEYS.STORE_INTEGRATIONS]) {
        merged[COMPANY_FEATURE_KEYS.SHOPIFY_INTEGRATION] = false;
        merged[COMPANY_FEATURE_KEYS.SFTP_INTEGRATION] = false;
    }
    return merged;
}

function extractOwnerFeatureFlags(row) {
    const rawFlags = row?.feature_flags && typeof row.feature_flags === "object" && !Array.isArray(row.feature_flags)
        ? row.feature_flags
        : row?.featureFlags && typeof row.featureFlags === "object" && !Array.isArray(row.featureFlags)
            ? row.featureFlags
            : null;
    const legacyMode = rawFlags == null;
    return {
        legacyMode,
        featureFlags: resolveCompanyFeatureFlags(rawFlags, { legacyMode })
    };
}

function getCompanyFeatureErrorMessage(featureKey, accountName = "") {
    const companyLabel = normalizeText(accountName || "") || "this company";
    switch (normalizeText(featureKey)) {
        case COMPANY_FEATURE_KEYS.CUSTOMER_PORTAL:
            return `Customer portal is not enabled for ${companyLabel}.`;
        case COMPANY_FEATURE_KEYS.ORDER_ENTRY:
            return `Sales order entry is not enabled for ${companyLabel}.`;
        case COMPANY_FEATURE_KEYS.INBOUND_NOTICES:
            return `Purchase orders are not enabled for ${companyLabel}.`;
        case COMPANY_FEATURE_KEYS.BILLING:
            return `Billing is not enabled for ${companyLabel}.`;
        case COMPANY_FEATURE_KEYS.STORE_INTEGRATIONS:
            return `Store integrations are not enabled for ${companyLabel}.`;
        case COMPANY_FEATURE_KEYS.SHOPIFY_INTEGRATION:
            return `Shopify integration is not enabled for ${companyLabel}.`;
        case COMPANY_FEATURE_KEYS.SFTP_INTEGRATION:
            return `SFTP integration is not enabled for ${companyLabel}.`;
        default:
            return `That feature is not enabled for ${companyLabel}.`;
    }
}

function assertCompanyFeatureEnabledForOwnerRow(row, featureKey, message = "") {
    const { featureFlags } = extractOwnerFeatureFlags(row);
    if (featureFlags[featureKey] !== true) {
        throw httpError(403, message || getCompanyFeatureErrorMessage(featureKey, row?.account_name || row?.name || ""));
    }
    return featureFlags;
}

function summarizeEnabledCompanyFeatures(featureFlagsInput) {
    const resolved = resolveCompanyFeatureFlags(featureFlagsInput, { legacyMode: false });
    const enabledLabels = COMPANY_FEATURE_CATALOG
        .filter((feature) => resolved[feature.key] === true)
        .map((feature) => feature.label);
    return enabledLabels.length
        ? `Enabled: ${enabledLabels.join(", ")}`
        : "All optional add-ons are turned off for this company.";
}

function normalizeStoreIntegrationProvider(value) {
    const normalized = normalizeText(value || "");
    return STORE_INTEGRATION_PROVIDERS.includes(normalized) ? normalized : "";
}

function normalizeStoreIntegrationSyncSchedule(value) {
    const normalized = normalizeText(value || "MANUAL");
    return STORE_INTEGRATION_SYNC_SCHEDULES.includes(normalized) ? normalized : "MANUAL";
}

function normalizeRemoteFolderPath(value) {
    const normalized = normalizeFreeText(value || "").replace(/\\/g, "/");
    if (!normalized) return "";
    const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const collapsed = withLeadingSlash.replace(/\/+/g, "/");
    if (collapsed.length > 1 && collapsed.endsWith("/")) {
        return collapsed.slice(0, -1);
    }
    return collapsed || "/";
}

function normalizeStoreIdentifierForProvider(provider, value) {
    const text = normalizeFreeText(value || "").toLowerCase();
    if (!text) return "";

    if (normalizeStoreIntegrationProvider(provider) === SHOPIFY_SYNC_PROVIDER) {
        const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
        try {
            return new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
        } catch (_error) {
            return text.replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0];
        }
    }

    if (normalizeStoreIntegrationProvider(provider) === SFTP_SYNC_PROVIDER) {
        const candidate = /^[a-z]+:\/\//i.test(text) ? text : `sftp://${text}`;
        try {
            return new URL(candidate).hostname.toLowerCase();
        } catch (_error) {
            return text.replace(/^sftp:\/\//i, "").replace(/^www\./, "").split(/[/:]/)[0];
        }
    }

    return text;
}

function describeStoreIntegrationProvider(provider) {
    switch (normalizeStoreIntegrationProvider(provider)) {
        case "SHOPIFY":
            return "Shopify";
        case "SFTP":
            return "SFTP";
        case "WOOCOMMERCE":
            return "WooCommerce";
        case "BIGCOMMERCE":
            return "BigCommerce";
        case "AMAZON":
            return "Amazon";
        case "ETSY":
            return "Etsy";
        case "CUSTOM_API":
            return "Custom API";
        default:
            return "Store";
    }
}

function describeStoreIntegrationSyncSchedule(schedule) {
    switch (normalizeStoreIntegrationSyncSchedule(schedule)) {
        case "EVERY_5_MINUTES":
            return "Every 5 Minutes";
        case "EVERY_15_MINUTES":
            return "Every 15 Minutes";
        case "EVERY_30_MINUTES":
            return "Every 30 Minutes";
        case "HOURLY":
            return "Hourly";
        case "DAILY_0900":
            return "Daily at 9:00 AM";
        case "DAILY_1200":
            return "Daily at 12:00 PM";
        case "DAILY_1500":
            return "Daily at 3:00 PM";
        case "DAILY_1800":
            return "Daily at 6:00 PM";
        default:
            return "Manual Only";
    }
}

function storeIntegrationProviderSupportsSync(provider) {
    const normalizedProvider = normalizeStoreIntegrationProvider(provider);
    return normalizedProvider === SHOPIFY_SYNC_PROVIDER || normalizedProvider === SFTP_SYNC_PROVIDER;
}

function storeIntegrationProviderSupportsAutoSync(provider) {
    const normalizedProvider = normalizeStoreIntegrationProvider(provider);
    return normalizedProvider === SHOPIFY_SYNC_PROVIDER || normalizedProvider === SFTP_SYNC_PROVIDER;
}

function computeNextStoreIntegrationSyncAt(schedule, { lastSyncedAt = null, now = new Date() } = {}) {
    const normalizedSchedule = normalizeStoreIntegrationSyncSchedule(schedule);
    if (normalizedSchedule === "MANUAL") {
        return null;
    }

    const currentTime = new Date(now);
    if (!Number.isFinite(currentTime.getTime())) {
        return null;
    }

    const intervalMs = STORE_INTEGRATION_INTERVAL_SCHEDULE_MS[normalizedSchedule];
    if (intervalMs) {
        const lastSyncDate = lastSyncedAt ? new Date(lastSyncedAt) : null;
        if (lastSyncDate && Number.isFinite(lastSyncDate.getTime())) {
            const candidate = new Date(lastSyncDate.getTime() + intervalMs);
            if (candidate > currentTime) {
                return candidate.toISOString();
            }
        }
        return currentTime.toISOString();
    }

    const dailyTime = STORE_INTEGRATION_DAILY_SCHEDULE_TIMES[normalizedSchedule];
    if (!dailyTime) {
        return null;
    }

    const candidate = new Date(currentTime);
    candidate.setHours(dailyTime.hour, dailyTime.minute, 0, 0);
    if (candidate <= currentTime) {
        candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.toISOString();
}

function ensureStoreIntegrationSchedulerStarted() {
    if (storeIntegrationSchedulerStarted) {
        return;
    }
    storeIntegrationSchedulerStarted = true;
    storeIntegrationSchedulerTimer = setInterval(() => {
        void runDueStoreIntegrationSyncs();
    }, STORE_INTEGRATION_SCHEDULER_INTERVAL_MS);
    if (typeof storeIntegrationSchedulerTimer?.unref === "function") {
        storeIntegrationSchedulerTimer.unref();
    }
    void runDueStoreIntegrationSyncs();
}

async function runDueStoreIntegrationSyncs() {
    if (!databaseReady || storeIntegrationSchedulerRunning) {
        return;
    }

    storeIntegrationSchedulerRunning = true;
    try {
        const dueResult = await pool.query(
            `
                select id
                from store_integrations
                where is_active = true
                  and sync_schedule <> 'MANUAL'
                  and next_scheduled_sync_at is not null
                  and next_scheduled_sync_at <= now()
                order by next_scheduled_sync_at asc, id asc
                limit 10
            `
        );
        for (const row of dueResult.rows) {
            try {
                await syncStoreIntegrationById(row.id, null);
            } catch (error) {
                console.error(`Store integration auto sync failed for ${row.id}:`, error.message || error);
            }
        }
    } catch (error) {
        console.error("Store integration scheduler failed:", error.message || error);
    } finally {
        storeIntegrationSchedulerRunning = false;
    }
}

function getTimeZoneDateParts(date = new Date(), timeZone = ADMIN_ACTIVITY_DIGEST_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
    const parts = formatter.formatToParts(date).reduce((accumulator, part) => {
        if (part.type !== "literal") {
            accumulator[part.type] = part.value;
        }
        return accumulator;
    }, {});
    return {
        year: Number.parseInt(parts.year || "0", 10) || 0,
        month: Number.parseInt(parts.month || "0", 10) || 0,
        day: Number.parseInt(parts.day || "0", 10) || 0,
        hour: Number.parseInt(parts.hour || "0", 10) || 0,
        minute: Number.parseInt(parts.minute || "0", 10) || 0,
        second: Number.parseInt(parts.second || "0", 10) || 0
    };
}

function getTimeZoneDateKey(date = new Date(), timeZone = ADMIN_ACTIVITY_DIGEST_TIME_ZONE) {
    const parts = getTimeZoneDateParts(date, timeZone);
    const year = String(parts.year || 0).padStart(4, "0");
    const month = String(parts.month || 0).padStart(2, "0");
    const day = String(parts.day || 0).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function isAdminActivityDigestDue(date = new Date()) {
    const parts = getTimeZoneDateParts(date, ADMIN_ACTIVITY_DIGEST_TIME_ZONE);
    if (!parts.year || !parts.month || !parts.day) {
        return false;
    }
    if (parts.hour > ADMIN_ACTIVITY_DIGEST_HOUR) {
        return true;
    }
    if (parts.hour < ADMIN_ACTIVITY_DIGEST_HOUR) {
        return false;
    }
    return parts.minute >= ADMIN_ACTIVITY_DIGEST_MINUTE;
}

function ensureAdminActivityDigestSchedulerStarted() {
    if (adminActivityDigestSchedulerStarted) {
        return;
    }
    adminActivityDigestSchedulerStarted = true;
    adminActivityDigestSchedulerTimer = setInterval(() => {
        void runDailyAdminActivityDigest();
    }, ADMIN_ACTIVITY_DIGEST_SCHEDULER_INTERVAL_MS);
    if (typeof adminActivityDigestSchedulerTimer?.unref === "function") {
        adminActivityDigestSchedulerTimer.unref();
    }
    void runDailyAdminActivityDigest();
}

async function claimScheduledJobRun(jobKey, runKey) {
    const result = await pool.query(
        `
            insert into scheduled_job_runs (
                job_key, run_key, status, started_at, updated_at
            )
            values ($1, $2, 'RUNNING', now(), now())
            on conflict (job_key, run_key)
            do update
            set
                status = 'RUNNING',
                started_at = now(),
                finished_at = null,
                error_message = '',
                updated_at = now()
            where scheduled_job_runs.status = 'FAILED'
               or (scheduled_job_runs.status = 'RUNNING' and scheduled_job_runs.started_at < now() - interval '30 minutes')
            returning id
        `,
        [jobKey, runKey]
    );
    return result.rows[0]?.id ? Number(result.rows[0].id) : 0;
}

async function finishScheduledJobRun(runId, status, { errorMessage = "", metadata = null } = {}) {
    if (!runId) return;
    await pool.query(
        `
            update scheduled_job_runs
            set
                status = $2,
                finished_at = now(),
                error_message = $3,
                metadata = coalesce($4::jsonb, metadata),
                updated_at = now()
            where id = $1
        `,
        [runId, status, errorMessage || "", metadata ? JSON.stringify(metadata) : null]
    );
}

async function runDailyAdminActivityDigest() {
    if (!databaseReady || adminActivityDigestSchedulerRunning) {
        return;
    }
    if (!ADMIN_ACTIVITY_SUMMARY_TO || !hasSystemEmailConfig()) {
        return;
    }

    const now = new Date();
    if (!isAdminActivityDigestDue(now)) {
        return;
    }

    adminActivityDigestSchedulerRunning = true;
    const runKey = getTimeZoneDateKey(now, ADMIN_ACTIVITY_DIGEST_TIME_ZONE);
    let runId = 0;
    try {
        runId = await claimScheduledJobRun(ADMIN_ACTIVITY_DIGEST_JOB_KEY, runKey);
        if (!runId) {
            return;
        }
        const digest = await buildAdminActivityDigest(runKey, { now });
        await sendAdminActivityDigestEmail(digest);
        await finishScheduledJobRun(runId, "SENT", {
            metadata: {
                recipient: ADMIN_ACTIVITY_SUMMARY_TO,
                summaryDate: digest.dateKey,
                totals: digest.totals
            }
        });
    } catch (error) {
        console.error("Admin activity digest failed:", error.message || error);
        await finishScheduledJobRun(runId, "FAILED", {
            errorMessage: error.message || String(error)
        });
    } finally {
        adminActivityDigestSchedulerRunning = false;
    }
}

function _maskSecretTailLegacy(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const tail = text.slice(-4);
    return `••••${tail}`;
}

function truncateStoreSyncMessage(value, maxLength = 500) {
    const text = normalizeFreeText(value || "");
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function maskSecretTail(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const tail = text.slice(-4);
    return `****${tail}`;
}

function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function sanitizeFilenameSegment(value, fallback = "file") {
    const sanitized = String(value || "")
        .trim()
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    return sanitized || fallback;
}

function formatFileTimestamp(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
    const iso = safeDate.toISOString();
    return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function createAppBuildInfo(rootDir, files = []) {
    const packageVersion = readPackageVersion(rootDir);
    const hash = crypto.createHash("sha256");
    let latestMtimeMs = 0;

    files.forEach((relativePath) => {
        const filePath = path.join(rootDir, relativePath);
        try {
            const stat = fs.statSync(filePath);
            const fileContents = fs.readFileSync(filePath);
            latestMtimeMs = Math.max(latestMtimeMs, Number(stat.mtimeMs) || 0);
            hash.update(relativePath);
            hash.update(fileContents);
        } catch {
            // Skip missing files so the build label can still render.
        }
    });

    const shortHash = hash.digest("hex").slice(0, 8).toUpperCase();
    const sourceStamp = latestMtimeMs ? formatFileTimestamp(new Date(latestMtimeMs)) : formatFileTimestamp(new Date());
    const railwayCommit = String(process.env.RAILWAY_GIT_COMMIT_SHA || "").trim();
    const deploymentRef = railwayCommit ? railwayCommit.slice(0, 8).toUpperCase() : shortHash;

    return {
        version: packageVersion,
        sourceStamp,
        deploymentRef,
        label: `v${packageVersion} | Build ${sourceStamp} | Ref ${deploymentRef}`
    };
}

function readPackageVersion(rootDir) {
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
        const version = String(packageJson?.version || "").trim();
        return version || "0.0.0";
    } catch {
        return "0.0.0";
    }
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
    if (pathName === "/api/version") return true;
    if (pathName === "/api/site/demo-request") return true;
    if (pathName === "/api/site/stripe-config") return true;
    if (pathName === "/api/site/stripe-checkout-session") return true;
    if (pathName === "/api/site/stripe-checkout") return true;
    if (pathName === "/api/site/stripe-webhook") return true;
    if (pathName === "/" || pathName === "/index.html") return true;
    if (pathName === "/marketing" || pathName === "/marketing.html") return true;
    if (pathName === "/pricing" || pathName === "/pricing.html") return true;
    if (pathName === "/industries" || pathName === "/industries.html") return true;
    if (pathName === "/book-demo" || pathName === "/book-demo.html") return true;
    if (pathName === "/integrations" || pathName === "/integrations.html") return true;
    if (pathName === "/implementation" || pathName === "/implementation.html") return true;
    if (pathName === "/robots.txt" || pathName === "/sitemap.xml") return true;
    if (pathName === "/marketing-logo.svg") return true;
    if (pathName === "/hero-warehouse-scene.svg") return true;
    if (pathName === "/industry-3pl-scene.svg") return true;
    if (pathName === "/industry-ecommerce-scene.svg") return true;
    if (pathName === "/industry-lot-control-scene.svg") return true;
    if (pathName === "/marketing.css" || pathName === "/marketing.js") return true;
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


