# WMS365 Pricing And Paywall Setup

## Public pricing

The public pricing page now publishes:
- Launch Warehouse: `$129 / month`, 1 warehouse, 3 users.
- Extra user: `$15 / month`.
- Extra warehouse: `$39 / month`.
- Customer portal: `$29 / month`.
- ASN / XML tools: `$79 / month`.
- Setup and onboarding: `$199` one-time.
- Data import: `$99` one-time.

The public marketing package is stored in `C:\WMS365Scanner\marketing`.

## Stripe setup

Required Railway environment variables:
- `STRIPE_SECRET_KEY`: Stripe secret key.
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret.
- `STRIPE_PRICE_LAUNCH_WAREHOUSE`: recurring Stripe price ID for the `$129 / month` Launch Warehouse plan.
- `PAYWALL_ENFORCEMENT_ENABLED`: defaults to `true`. Set to `false` only if you want monitor-only rollout before enforcing portal access.

Existing public pages use Stripe Checkout for the Launch Warehouse subscription. Successful Stripe subscriptions create/update the company shell, mark software access as paid subscription, and turn on feature flags for the selected plan.

## Company paywall behavior

Customer portal access is checked at login and on active portal sessions.

Allowed access:
- Company has `Software Access = No-charge`.
- Company is assigned to a Grey Wolf 3PL fulfillment location such as `GW3PL-MISS`.
- Company has `Software Access = Paid subscription` with status `Active`, `Trialing`, or `No charge`.
- Company has a latest Stripe subscription with status `Active` or `Trialing`.

Blocked access:
- Company has `Software Access = Blocked`.
- Company has no Grey Wolf assignment and no active/trial Stripe subscription while paywall enforcement is enabled.

Current Grey Wolf 3PL customers should stay no-charge by assigning their company to the Grey Wolf 3PL fulfillment location. This keeps customer data scoped to its own company while avoiding software charges for Grey Wolf-serviced customers.

## Super user workflow

1. Open `Master Data & Setup`.
2. Create or load the company.
3. Assign the primary fulfillment location.
4. Set `Pricing Plan`.
5. Set `Software Access`.
6. Save the company.

Use `Auto` for normal behavior: Grey Wolf-assigned companies get no-charge portal access; other companies require an active Stripe subscription.
