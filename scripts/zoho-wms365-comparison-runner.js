const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const LOG_PATH = path.join(ROOT, "docs", "ZOHO_WMS365_COMPARISON_LOG.md");
const ARTIFACT_DIR = path.join(ROOT, "test-results", "zoho-wms365-comparisons");
const PROFILE_DIR = path.join(ROOT, ".playwright-zoho-wms365-compare");

const ZOHO_URL = process.env.ZOHO_BOOKS_URL || "https://books.zoho.com/app";
const WMS_URL = process.env.WMS365_BILLING_URL || "https://app.wms365.co/billing-accounting";
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS === "1";
const WAIT_MS = Number(process.env.PLAYWRIGHT_AUTH_WAIT_MS || 180000);

const comparisons = [
    {
        key: "home",
        zohoLabel: "Home",
        wmsFocus: "Dashboard",
        expectedWms: ["Dashboard", "Total invoiced", "Outstanding", "Recent invoices", "Recent bills"]
    },
    {
        key: "items",
        zohoLabel: "Items",
        wmsFocus: "Rate Cards / charge catalog",
        expectedWms: ["Rate Cards", "charge", "unit", "Custom charge"]
    },
    {
        key: "inventory",
        zohoLabel: "Inventory",
        wmsFocus: "Billing Activity",
        expectedWms: ["Billing Events", "Receiving", "Storage", "Picking", "Shipping"]
    },
    {
        key: "sales",
        zohoLabel: "Sales",
        wmsFocus: "Invoices / customer receivables",
        expectedWms: ["Invoices", "PDF", "Email", "Paid", "Overdue"]
    },
    {
        key: "purchases",
        zohoLabel: "Purchases",
        wmsFocus: "Bills / Expenses / Vendors",
        expectedWms: ["Expenses", "Vendors", "Bills", "Paid", "Unpaid"]
    },
    {
        key: "time-tracking",
        zohoLabel: "Time Tracking",
        wmsFocus: "Labour billing and profitability",
        expectedWms: ["Labour", "hour", "profitability"]
    },
    {
        key: "banking",
        zohoLabel: "Banking",
        wmsFocus: "Banking",
        expectedWms: ["Banking", "Deposits", "Withdrawals", "Reconciliation"]
    },
    {
        key: "filing-compliance",
        zohoLabel: "Filing & Compliance",
        wmsFocus: "Tax Center",
        expectedWms: ["Tax Center", "HST", "GST", "PST", "Tax payable"]
    },
    {
        key: "accountant",
        zohoLabel: "Accountant",
        wmsFocus: "Accounting",
        expectedWms: ["Accounting", "Chart of Accounts", "Journal", "General Ledger", "Trial Balance"]
    },
    {
        key: "reports",
        zohoLabel: "Reports",
        wmsFocus: "Reports / Accountant Export / Documents",
        expectedWms: ["Reports", "Profit & Loss", "Balance Sheet", "General Ledger", "Accountant Export"]
    }
];

function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function isZohoAuthenticated(url) {
    return /books\.zoho\./i.test(url) && !/accounts\.zoho\./i.test(url) && !/signin/i.test(url);
}

function isWmsAuthenticated(url) {
    return /app\.wms365\.co\/billing-accounting/i.test(url) && !/\/login/i.test(url);
}

async function extractPage(page) {
    const body = normalizeText(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
    const headings = await page.locator("h1,h2,h3,[role='heading']").evaluateAll((nodes) => nodes
        .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 40)).catch(() => []);
    const controls = await page.locator("a,button,[role='button'],[role='menuitem'],summary").evaluateAll((nodes) => nodes
        .map((node) => (node.innerText || node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 80)).catch(() => []);
    const fields = await page.locator("input,textarea,select").evaluateAll((nodes) => nodes
        .map((node) => [
            node.getAttribute("aria-label"),
            node.getAttribute("placeholder"),
            node.getAttribute("name"),
            node.getAttribute("id")
        ].filter(Boolean).join(" / "))
        .filter(Boolean)
        .slice(0, 50)).catch(() => []);
    return { url: page.url(), title: await page.title(), body, headings, controls, fields };
}

async function clickZohoArea(page, label) {
    const candidates = [
        page.getByRole("button", { name: new RegExp(`^${escapeRegExp(label)}`, "i") }),
        page.getByRole("link", { name: new RegExp(`^${escapeRegExp(label)}`, "i") }),
        page.getByText(label, { exact: true })
    ];
    for (const locator of candidates) {
        try {
            if (await locator.first().isVisible({ timeout: 1500 })) {
                await locator.first().click({ timeout: 5000 });
                await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(1500);
                return true;
            }
        } catch {
            // Try the next selector. Zoho's left rail shifts between icon-only and text variants.
        }
    }
    return false;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function coverageStatus(wmsText, expected) {
    const upper = normalizeText(wmsText).toUpperCase();
    const hits = expected.filter((item) => upper.includes(String(item).toUpperCase()));
    if (hits.length === expected.length) return { status: "covered", hits };
    if (hits.length) return { status: "partial", hits };
    return { status: "missing", hits };
}

function isAuthBlocked(snapshot, appName) {
    const text = normalizeText(`${snapshot.url} ${snapshot.title} ${snapshot.body}`).toUpperCase();
    if (appName === "zoho") return text.includes("ZOHO ACCOUNTS") || text.includes("SIGN IN TO ACCESS BOOKS");
    if (appName === "wms") return text.includes("WAREHOUSE LOGIN") || text.includes("WAREHOUSE STAFF LOGIN REQUIRED");
    return false;
}

function summarizeList(items, limit = 8) {
    return items.slice(0, limit).map((item) => `\`${item.replace(/`/g, "'")}\``).join(", ") || "_none captured_";
}

function appendLog(markdown) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    if (!fs.existsSync(LOG_PATH)) {
        fs.writeFileSync(LOG_PATH, "# Zoho Books To WMS365 Billing & Accounting Comparison Log\n\n", "utf8");
    }
    fs.appendFileSync(LOG_PATH, markdown, "utf8");
}

(async () => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS,
        viewport: { width: 1440, height: 1000 },
        args: HEADLESS ? [] : ["--start-maximized"]
    });
    const zohoPage = await browser.newPage();
    const wmsPage = await browser.newPage();
    await zohoPage.goto(ZOHO_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await wmsPage.goto(WMS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        if ((isZohoAuthenticated(zohoPage.url()) || HEADLESS) && (isWmsAuthenticated(wmsPage.url()) || HEADLESS)) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const zohoAuthed = isZohoAuthenticated(zohoPage.url());
    const wmsAuthed = isWmsAuthenticated(wmsPage.url());
    const passStamp = new Date().toISOString();
    const safeStamp = passStamp.replace(/[:.]/g, "-");
    const wmsSnapshot = await extractPage(wmsPage);

    const rows = [];
    for (const comparison of comparisons) {
        let clicked = false;
        if (zohoAuthed) clicked = await clickZohoArea(zohoPage, comparison.zohoLabel);
        const zohoSnapshot = await extractPage(zohoPage);
        const zohoBlocked = isAuthBlocked(zohoSnapshot, "zoho");
        const wmsBlocked = isAuthBlocked(wmsSnapshot, "wms");
        const coverage = wmsBlocked
            ? { status: "blocked", hits: [] }
            : coverageStatus(wmsSnapshot.body, comparison.expectedWms);
        const screenshotName = `${safeStamp}-${comparison.key}.png`;
        await zohoPage.screenshot({ path: path.join(ARTIFACT_DIR, screenshotName), fullPage: true }).catch(() => {});
        rows.push({ comparison, clicked, zohoSnapshot, coverage, screenshotName, zohoBlocked, wmsBlocked });
    }

    const jsonPath = path.join(ARTIFACT_DIR, `${safeStamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({
        passStamp,
        zohoAuthed,
        wmsAuthed,
        zohoUrl: zohoPage.url(),
        wmsUrl: wmsPage.url(),
        rows
    }, null, 2), "utf8");

    const markdown = [
        "",
        `## Playwright Comparison Pass - ${passStamp}`,
        "",
        `Zoho authenticated: **${zohoAuthed ? "yes" : "no"}** (${zohoPage.url()})`,
        `WMS365 authenticated: **${wmsAuthed ? "yes" : "no"}** (${wmsPage.url()})`,
        `Artifacts: \`${path.relative(ROOT, jsonPath)}\``,
        "",
        "| # | Zoho area | WMS365 focus | Capture result | Coverage read | Build log item |",
        "|---|---|---|---|---|---|",
        ...rows.map((row, index) => {
            const { comparison, clicked, zohoSnapshot, coverage } = row;
            const captureResult = row.zohoBlocked
                ? "blocked by Zoho login"
                : zohoAuthed
                ? `${clicked ? "opened" : "not opened"}; headings: ${summarizeList(zohoSnapshot.headings, 3)}`
                : "limited unauthenticated capture";
            const buildItem = coverage.status === "blocked"
                ? "Run again after WMS365 login to score coverage."
                : coverage.status === "covered"
                ? "Validate workflow depth with authenticated WMS365 screenshots."
                : coverage.status === "partial"
                    ? `Harden missing pieces around ${comparison.expectedWms.filter((item) => !coverage.hits.includes(item)).join(", ")}.`
                    : `Build/verify ${comparison.wmsFocus} replacement workflow.`;
            return `| ${index + 1} | ${comparison.zohoLabel} | ${comparison.wmsFocus} | ${captureResult.replace(/\|/g, "/")} | ${coverage.status}; hits: ${coverage.hits.join(", ") || "none"} | ${buildItem.replace(/\|/g, "/")} |`;
        }),
        "",
        "Notes:",
        `- Zoho controls captured from final page: ${summarizeList(rows[0]?.zohoSnapshot?.controls || [], 12)}.`,
        `- WMS365 page title captured: \`${wmsSnapshot.title || "none"}\`; first headings: ${summarizeList(wmsSnapshot.headings, 8)}.`,
        ""
    ].join("\n");

    appendLog(markdown);
    console.log(`Appended comparison pass to ${LOG_PATH}`);
    console.log(JSON.stringify({
        passStamp,
        zohoAuthed,
        wmsAuthed,
        logPath: LOG_PATH,
        artifactJson: jsonPath,
        comparisons: rows.map((row) => ({
            zohoArea: row.comparison.zohoLabel,
            clicked: row.clicked,
            coverage: row.coverage.status,
            hits: row.coverage.hits
        }))
    }, null, 2));
    await browser.close();
})();
