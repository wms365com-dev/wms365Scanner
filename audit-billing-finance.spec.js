const { test, expect } = require("@playwright/test");
const fs = require("fs");
const http = require("http");
const path = require("path");

const financeState = {
  dashboard: {
    revenueThisMonth: 8500,
    expensesThisMonth: 3200,
    grossProfit: 5300,
    netProfit: 4700,
    outstandingReceivables: 660.5,
    outstandingPayables: 1356,
    unbilledWarehouseActivity: 180,
    taxPayable: 250.5,
    storageRevenue: 720,
    pickPackRevenue: 130,
    freightRevenue: 0,
    topCustomers: [{ customerId: "DEMO 3PL CUSTOMER", customerName: "Demo 3PL Customer", amount: 960.5 }],
    overdueInvoices: [{ invoiceNumber: "INV-000002", customerId: "DEMO 3PL CUSTOMER", dueDate: "2026-04-30", balanceDue: 250 }],
    charts: {
      monthlyRevenue: [{ month: "2026-01", amount: 1000 }, { month: "2026-02", amount: 2200 }, { month: "2026-03", amount: 3200 }],
      monthlyExpenses: [{ month: "2026-01", amount: 800 }, { month: "2026-02", amount: 900 }, { month: "2026-03", amount: 1200 }],
      profitTrend: [{ month: "2026-01", amount: 200 }, { month: "2026-02", amount: 1300 }, { month: "2026-03", amount: 2000 }],
      invoiceAging: [{ bucket: "Current", amount: 660.5 }, { bucket: "1-30", amount: 250 }]
    }
  },
  profiles: [{ id: "1", accountName: "DEMO 3PL CUSTOMER", customerName: "Demo 3PL Customer", billingContact: "Accounts Payable", email: "ap@example.com", paymentTerms: "Net 30", currency: "CAD", minimumMonthlyBilling: 250, creditLimit: 7500, isActive: true }],
  rateCards: [{ id: "1", name: "Standard 3PL Rate Card", lines: [{ chargeType: "PALLET_STORAGE_MONTHLY", unit: "Per pallet", rate: 18, taxCode: "HST_ON" }] }],
  rateCardHistory: [],
  billingEvents: [{ id: "1", customerId: "DEMO 3PL CUSTOMER", activityDate: "2026-05-10", activityType: "Receiving", chargeType: "RECEIVING_PALLET", quantity: 24, unitRate: 7.5, amount: 180, taxCode: "HST_ON", status: "approved", sourceModule: "Seed", sourceReference: "DEMO-RCPT-001" }],
  invoices: [{ id: "1", invoiceNumber: "INV-000001", customerId: "DEMO 3PL CUSTOMER", invoiceDate: "2026-05-02", dueDate: "2026-06-01", status: "partial", subtotal: 850, tax: 110.5, total: 960.5, paidAmount: 300, balanceDue: 660.5, lines: [{ description: "Monthly pallet storage", chargeType: "PALLET_STORAGE_MONTHLY", quantity: 40, unitRate: 18, taxAmount: 93.6, amount: 720 }] }],
  payments: [{ id: "1", paymentDate: "2026-05-09", customerId: "DEMO 3PL CUSTOMER", invoiceReference: "INV-000001", amount: 300, paymentMethod: "EFT", referenceNumber: "DEMO-PAY-001", unappliedAmount: 0 }],
  expenses: [{ id: "1", expenseDate: "2026-05-05", vendor: "Demo Labour Agency", expenseCategory: "Agency labour", description: "Temporary warehouse labour", amountBeforeTax: 1200, taxAmount: 156, totalAmount: 1356, paymentStatus: "unpaid", billable: true }],
  vendors: [{ id: "1", vendorName: "Demo Labour Agency", contactName: "Dispatch", email: "dispatch@example.com", phone: "555-0199", taxNumber: "123456789RT0001", outstandingBalance: 1356 }],
  vendorBills: [],
  vendorPayments: [],
  bankAccounts: [{ id: "1", accountName: "Operating Account", currentBalance: 5000 }],
  bankTransactions: [{ id: "1", bankAccountId: "1", transactionDate: "2026-05-09", transactionType: "deposit", description: "Customer EFT", amount: 300 }],
  bankReconciliations: [],
  chartOfAccounts: [{ id: "1", accountCode: "1000", accountName: "Cash", accountType: "Assets", isActive: true }, { id: "2", accountCode: "4000", accountName: "Warehouse Revenue", accountType: "Revenue", isActive: true }],
  journalEntries: [{ id: "1", entryNumber: "JE-000001", entryDate: "2026-05-02", sourceType: "invoice", memo: "Invoice INV-000001", lines: [{ accountCode: "1100", debit: 960.5, credit: 0 }] }],
  taxCodes: [{ id: "1", code: "HST_ON", name: "HST Ontario", rate: 13, province: "ON", recoverable: true, isActive: true }],
  catalog: {
    chargeTypes: [{ code: "PALLET_STORAGE_MONTHLY", name: "Pallet storage monthly", unit: "Per pallet" }, { code: "RECEIVING_PALLET", name: "Receiving pallet", unit: "Per pallet" }],
    units: ["Per pallet", "Per carton", "Per unit", "Per hour", "Per order", "Per shipment", "Flat fee", "Percentage"],
    activityTypes: ["Receiving", "Putaway", "Storage", "Picking", "Packing", "Shipping", "Relabeling", "Labour"],
    expenseCategories: ["Rent", "Utilities", "Labour", "Agency labour", "Freight", "Supplies", "Software", "Insurance"],
    paymentMethods: ["EFT", "Cheque", "Cash", "Credit card", "Wire", "PayPal"]
  }
};

test("Billing & Finance module exposes Zoho replacement surfaces", async ({ page }) => {
  let server;
  const indexHtml = fs.readFileSync(path.resolve("index.html"), "utf8");
  const serverState = {
      inventory: [],
      pallets: [],
      activity: [],
      warehouseTasks: [],
      masters: { locations: [], ownerRecords: [{ name: "DEMO 3PL CUSTOMER", featureFlags: { BILLING: true } }], fulfillmentLocations: [], companyFulfillmentLocations: [], partners: [], items: [], owners: ["DEMO 3PL CUSTOMER"] },
      billing: { feeCatalog: [], ownerRates: [], events: [] },
      session: { appUser: { id: "1", email: "finance@example.com", fullName: "Finance Manager", role: "FINANCE_MANAGER", isActive: true } },
      admin: { appUsers: [] },
      featureCatalog: [],
      meta: { version: 8, serverSyncedAt: new Date().toISOString() }
  };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (value) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/version") return json({ build: { label: "audit" } });
    if (url.pathname === "/api/state") return json(serverState);
    if (url.pathname === "/api/billing-finance") return json(financeState);
    if (url.pathname.startsWith("/api/billing-finance/reports/")) return json({ success: true, report: { title: "Profit & Loss", columns: ["Metric", "Amount"], rows: [["Revenue", 850], ["Expenses", 1356], ["Net Profit", -506]] } });
    if (url.pathname === "/api/billing-finance/export") return json({ success: true, export: { filename: "audit.csv", mimeType: "text/csv", content: "Metric,Amount\nRevenue,850" } });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(indexHtml);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    await page.goto(`http://127.0.0.1:${port}/app`);
    await page.waitForFunction(() => {
      const home = document.querySelector("#homePanel");
      const finance = document.querySelector("#billingFinancePanel");
      return home && finance && home.hidden === false && finance.hidden === true;
    });
    await expect(page.locator('[data-section="billing"]')).toHaveCount(1);
    await expect(page.locator('[data-section="billing-finance"]')).toHaveCount(1);

    const financeMenu = page.locator("details.module-menu").filter({ hasText: "Finance" }).first();
    await expect(financeMenu.locator("summary")).toBeVisible();
    await financeMenu.locator("summary").click();
    await financeMenu.locator('[data-jump-section="billing-finance"]').click();
    await expect(page.locator("#billingFinancePanel")).toBeVisible();
    await expect(page.locator("#homePanel")).toBeHidden();

    for (const tab of ["Dashboard", "Customer Profiles", "Rate Cards", "Billing Events", "Invoices", "Payments", "Expenses", "Vendors", "Banking", "Accounting", "Tax Center", "Reports", "Accountant Export"]) {
      await expect(page.locator("#financeTabbar").getByText(tab, { exact: true })).toBeVisible();
    }

    await expect(page.locator("#financeRevenueMonth")).toContainText("$8,500.00");
    await expect(page.locator("#financeTopCustomersBody")).toContainText("Demo 3PL Customer");

    await page.locator('[data-finance-tab="invoices"]').click();
    await expect(page.locator("#financeInvoicesBody")).toContainText("INV-000001");
    await expect(page.locator("#financeExportInvoicePdfBtn")).toBeVisible();
    await expect(page.locator("#financeEmailInvoiceBtn")).toBeVisible();

    await page.locator('[data-finance-tab="payments"]').click();
    await expect(page.locator("#financePaymentsBody")).toContainText("DEMO-PAY-001");

    await page.locator('[data-finance-tab="accounting"]').click();
    await expect(page.locator("#financeAccountsBody")).toContainText("Warehouse Revenue");
    await expect(page.locator("#financeJournalBody")).toContainText("JE-000001");

    await page.locator('[data-finance-tab="tax"]').click();
    await expect(page.locator("#financeTaxCodesBody")).toContainText("HST_ON");

    await page.locator('[data-finance-tab="reports"]').click();
    await page.locator("#financeRunReportBtn").click();
    await expect(page.locator("#financeReportTitle")).toContainText("Profit & Loss");
    await expect(page.locator("#billingFinancePanel")).toBeVisible();
    await expect(page.locator("#homePanel")).toBeHidden();

    await page.screenshot({ path: "test-results/billing-finance-zoho-replacement-audit.png", fullPage: true });
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
