# Zoho Books To WMS365 Billing & Accounting Comparison Log

Purpose: keep a running audit trail of Zoho Books screens compared against WMS365 Billing & Accounting so the replacement build list grows from observed workflow gaps, not guesswork.

How to append:

```powershell
node scripts/zoho-wms365-comparison-runner.js
```

For authenticated comparisons, sign into Zoho Books and WMS365 in the visible Playwright browser when prompted. The runner appends a dated pass below.


## Playwright Comparison Pass - 2026-05-13T03:28:51.675Z

Zoho authenticated: **no** (https://books.zohocloud.ca/app#/home/gettingstarted)
WMS365 authenticated: **no** (https://app.wms365.co/login)
Artifacts: `test-results\zoho-wms365-comparisons\2026-05-13T03-28-51-675Z.json`

| # | Zoho area | WMS365 focus | Capture result | Coverage read | Build log item |
|---|---|---|---|---|---|
| 1 | Home | Dashboard | blocked by Zoho login | missing; hits: none | Build/verify Dashboard replacement workflow. |
| 2 | Items | Rate Cards / charge catalog | blocked by Zoho login | missing; hits: none | Build/verify Rate Cards / charge catalog replacement workflow. |
| 3 | Inventory | Billing Activity | blocked by Zoho login | partial; hits: Receiving | Harden missing pieces around Billing Events, Storage, Picking, Shipping. |
| 4 | Sales | Invoices / customer receivables | blocked by Zoho login | partial; hits: Email | Harden missing pieces around Invoices, PDF, Paid, Overdue. |
| 5 | Purchases | Bills / Expenses / Vendors | blocked by Zoho login | missing; hits: none | Build/verify Bills / Expenses / Vendors replacement workflow. |
| 6 | Time Tracking | Labour billing and profitability | blocked by Zoho login | missing; hits: none | Build/verify Labour billing and profitability replacement workflow. |
| 7 | Banking | Banking | blocked by Zoho login | missing; hits: none | Build/verify Banking replacement workflow. |
| 8 | Filing & Compliance | Tax Center | blocked by Zoho login | missing; hits: none | Build/verify Tax Center replacement workflow. |
| 9 | Accountant | Accounting | blocked by Zoho login | missing; hits: none | Build/verify Accounting replacement workflow. |
| 10 | Reports | Reports / Accountant Export / Documents | blocked by Zoho login | missing; hits: none | Build/verify Reports / Accountant Export / Documents replacement workflow. |

Notes:
- Zoho controls captured from final page: `Don't show again`, `Navigate To (Alt+0)`, `Show dropdown menu`, `Show dropdown menu`, `Grey Wolf 3PL & Logistics Inc`, `Show dropdown menu`, `Home`, `Items`, `Items`, `Inventory`, `Inventory Adjustments`, `Sales`.
- WMS365 page title captured: `WMS365 Warehouse Login`; first headings: `Warehouse staff sign in here to work the system.`, `Warehouse Login`.

## Playwright Comparison Pass - 2026-05-13T03:29:48.588Z

Zoho authenticated: **no** (https://accounts.zoho.com/signin?servicename=ZohoBooks&signupurl=https://www.zoho.com/books/signup&serviceurl=https%3A%2F%2Fbooks.zoho.com%2Fapp)
WMS365 authenticated: **no** (https://app.wms365.co/login?next=%2Fbilling-accounting)
Artifacts: `test-results\zoho-wms365-comparisons\2026-05-13T03-29-48-588Z.json`

| # | Zoho area | WMS365 focus | Capture result | Coverage read | Build log item |
|---|---|---|---|---|---|
| 1 | Home | Dashboard | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 2 | Items | Rate Cards / charge catalog | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 3 | Inventory | Billing Activity | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 4 | Sales | Invoices / customer receivables | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 5 | Purchases | Bills / Expenses / Vendors | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 6 | Time Tracking | Labour billing and profitability | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 7 | Banking | Banking | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 8 | Filing & Compliance | Tax Center | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 9 | Accountant | Accounting | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |
| 10 | Reports | Reports / Accountant Export / Documents | blocked by Zoho login | blocked; hits: none | Run again after WMS365 login to score coverage. |

Notes:
- Zoho controls captured from final page: `Sign in using LDAP password`, `Sign in using password`, `Signin using Time-based OTP`, `Waiting for approval`, `Verify`, `Next`, `Create Account`, `Continue`, `support@zohoaccounts.com`, `Verify`, `Next`, `Verify`.
- WMS365 page title captured: `WMS365 Warehouse Login`; first headings: `Warehouse staff sign in here to work the system.`, `Warehouse Login`.

## Playwright Comparison Pass - 2026-05-13T03:54:28.156Z

Zoho authenticated: **no** (https://books.zohocloud.ca/app#/home/gettingstarted)
WMS365 authenticated: **yes** (https://app.wms365.co/billing-accounting)
Artifacts: `test-results\zoho-wms365-comparisons\2026-05-13T03-54-28-156Z.json`

| # | Zoho area | WMS365 focus | Capture result | Coverage read | Build log item |
|---|---|---|---|---|---|
| 1 | Home | Dashboard | limited unauthenticated capture | partial; hits: Dashboard, Outstanding | Harden missing pieces around Total invoiced, Recent invoices, Recent bills. |
| 2 | Items | Rate Cards / charge catalog | limited unauthenticated capture | partial; hits: Rate Cards | Harden missing pieces around charge, unit, Custom charge. |
| 3 | Inventory | Billing Activity | limited unauthenticated capture | partial; hits: Billing Events, Storage | Harden missing pieces around Receiving, Picking, Shipping. |
| 4 | Sales | Invoices / customer receivables | limited unauthenticated capture | partial; hits: Invoices, Email, Overdue | Harden missing pieces around PDF, Paid. |
| 5 | Purchases | Bills / Expenses / Vendors | limited unauthenticated capture | partial; hits: Expenses, Vendors | Harden missing pieces around Bills, Paid, Unpaid. |
| 6 | Time Tracking | Labour billing and profitability | limited unauthenticated capture | missing; hits: none | Build/verify Labour billing and profitability replacement workflow. |
| 7 | Banking | Banking | limited unauthenticated capture | partial; hits: Banking | Harden missing pieces around Deposits, Withdrawals, Reconciliation. |
| 8 | Filing & Compliance | Tax Center | limited unauthenticated capture | partial; hits: Tax Center, Tax payable | Harden missing pieces around HST, GST, PST. |
| 9 | Accountant | Accounting | limited unauthenticated capture | partial; hits: Accounting | Harden missing pieces around Chart of Accounts, Journal, General Ledger, Trial Balance. |
| 10 | Reports | Reports / Accountant Export / Documents | limited unauthenticated capture | partial; hits: Reports, Accountant Export | Harden missing pieces around Profit & Loss, Balance Sheet, General Ledger. |

Notes:
- Zoho controls captured from final page: `Don't show again`, `Navigate To (Alt+0)`, `Show dropdown menu`, `Show dropdown menu`, `Grey Wolf 3PL & Logistics Inc`, `Show dropdown menu`, `Home`, `Items`, `Items`, `Inventory`, `Inventory Adjustments`, `Sales`.
- WMS365 page title captured: `WMS365 Warehouse Management System`; first headings: `Add Company`, `Warehouse Operations`, `Page Information`, `Warehouse Statistics`, `Current View`, `Related Actions`, `Choose Task`, `Plan Today's Work`.
