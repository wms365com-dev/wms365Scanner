# WMS365 Pricing And Paywall Setup

## Public pricing

The public pricing page now publishes:
- Launch Warehouse: 14-day credit-card trial, then `$129 / month`, 1 warehouse, 3 users.
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
- `STRIPE_API_VERSION`: defaults to `2026-02-25.clover`.
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret.
- `STRIPE_PRICE_LAUNCH_WAREHOUSE`: recurring Stripe price ID for the `$129 / month` Launch Warehouse plan.
- `STRIPE_LAUNCH_TRIAL_DAYS`: defaults to `14`. Stripe Checkout collects the customer's credit card and starts the subscription after this free-trial window unless canceled.
- `PAYWALL_ENFORCEMENT_ENABLED`: defaults to `true`. Set to `false` only if you want monitor-only rollout before enforcing portal access.

Existing public pages use Stripe Checkout for the Launch Warehouse subscription. Successful Stripe subscriptions create/update the company shell, mark software access as paid subscription, and turn on feature flags for the selected plan.

Stripe webhook endpoint:
- `https://app.wms365.co/api/site/stripe-webhook`

Subscribe the endpoint to:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

The webhook route must receive Stripe's raw JSON body before the global JSON parser runs. WMS365 keeps the webhook route out of the global JSON parser and verifies events with `STRIPE_WEBHOOK_SECRET`.

Launch Warehouse checkout is configured as a card-backed 14-day free trial:
- Checkout collects a payment method during signup.
- Stripe creates the subscription in trialing status.
- The first `$129/month` charge starts after the trial unless the subscription is canceled before trial end.

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
