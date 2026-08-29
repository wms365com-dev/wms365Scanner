# WMS365 — Codex Task Briefs

Send these **one at a time**, in order. Do not paste the whole file as a single prompt.

---

## Standing rules (paste at the top of every task)

```
Repo: WMS365 — Express + PostgreSQL 3PL warehouse management SaaS on Railway.
server.js is ~31,000 lines and is the entire backend. index.html is ~30,000 lines
with ~19,500 lines of inline JS. These files are large on purpose; do NOT refactor,
reformat, or reorganize them.

Rules for this task:
- Change only what the task asks for. Narrow diffs.
- Do not reformat untouched lines. Do not reorder functions or imports.
- Do not "improve" adjacent code you happen to read.
- Do not add dependencies without saying so explicitly and why.
- Schema changes go in a new file under migrations/ AND in the matching
  `create table if not exists` block in server.js (the app creates its schema at boot).
- Before sending customer portal/user access details, test the issued credentials in
  the live portal and confirm the correct customer account loads. Do not send access
  until login verification passes; if it cannot be verified, report the blocker.
- When done, list: files touched, lines added/removed, and how you verified it.
- If a change can't be verified by a test, say so plainly rather than claiming it works.
```

---

## Task 1 — Make the test suite runnable (do this FIRST)

```
There are 12 *.spec.js files at the repo root. Only 5 have npm scripts. There is no
`npm test`. audit-billing-finance.spec.js imports @playwright/test, which is not in
package.json at all.

Do this:
1. Add a "test" script to package.json that runs all node:test specs:
   node --test *.spec.js  — but EXCLUDE audit-billing-finance.spec.js, which is Playwright.
   Name the Playwright one "test:audit" and wire it to playwright.audit.config.js.
2. Add @playwright/test to devDependencies at the version the spec actually needs.
3. Run `npm test`. Report which specs pass, which fail, and which error on import.
   Do NOT fix failing specs in this task. Just report the baseline.
4. Add a GitHub Actions workflow at .github/workflows/ci.yml that runs `npm ci`
   and `npm test` on push and pull_request. Node 20. Do not add the Playwright job yet.

Deliverable: a green-or-known-red baseline I can trust before any behavior changes.
```

**Why first:** everything after this is unverifiable without it. Read the baseline report yourself — if a spec was already failing, you need to know that *before* Codex starts changing code, or you'll blame the wrong commit.

---

## Task 2 — Fix the store integration scheduler double-run (the real bug)

```
Bug: runDueStoreIntegrationSyncs() at server.js:30701 selects due rows from
store_integrations and syncs them, but next_scheduled_sync_at is only advanced AFTER
the sync completes (inside syncStoreIntegrationById, ~line 11762). The only mutual
exclusion is the in-process boolean `storeIntegrationSchedulerRunning` and the
in-process Set `storeIntegrationSyncLocks` (~line 11727).

On two or more Railway instances, both processes select the same due row and both run
the Shopify sync. importStoreOrdersForIntegration (~line 11869) writes the portal order
draft BEFORE inserting into store_order_imports, so the unique constraint on
(integration_id, external_order_id) fires too late to prevent a duplicate customer order.

This codebase already solves this correctly in two places — follow those patterns, do
not invent a third:
- processScheduledPortalShipmentConfirmationEmail (~line 20642) uses an atomic
  conditional UPDATE ... WHERE status='SCHEDULED' ... RETURNING, then checks rowCount === 1.
- claimScheduledJobRun (~line 30797) uses the scheduled_job_runs table with a stale-
  RUNNING reclaim after 30 minutes.

Do this:
1. Claim each integration row atomically before syncing: advance next_scheduled_sync_at
   (or set a sync_claimed_at / sync_status='RUNNING') in a single UPDATE ... RETURNING
   guarded by the current value, and only sync if rowCount === 1. Alternatively use
   SELECT ... FOR UPDATE SKIP LOCKED — server.js:21907 already uses that pattern once.
2. Add a stale-claim reclaim so a crashed instance does not wedge an integration forever.
   Match the 15/30-minute convention already used elsewhere.
3. Make the store_order_imports insert an explicit upsert (ON CONFLICT DO NOTHING) and
   move it so a duplicate external_order_id cannot result in a committed portal order.
   Verify the whole import is inside the existing withTransaction call.
4. Write tests in store-integration-scheduler.spec.js proving:
   - two concurrent claims of the same integration → exactly one wins
   - a stale claim older than the threshold is reclaimable
   - importing the same external_order_id twice creates exactly one portal order

Constraint: the existing spec only unit-tests pure helpers with mocked pg clients and
mocked global.fetch. Follow that style. Do not require a live database.
```

**Why this one:** it's the only item on the list that silently corrupts customer data. Everything else is hardening.

---

## Task 3 — Fix the two fail-open defaults

```
Two separate issues, both small, both security-relevant. Do them in one diff.

A) server.js:6902 — the app_users table declares `role text not null default 'super_admin'`.
   Every current INSERT sets role explicitly, so nothing is broken today. But the default
   means any future insert that omits the column silently creates a super admin.
   Change the column default to the least-privileged role ('warehouse_worker').
   Add a migration that alters the default on existing databases. Do NOT change any
   existing user's role — the migration touches the default only, not the rows.
   Confirm by grep that no code path relies on the old default.

B) server.js:347 — AUTHORIZED_AUTOMATION_OWNER_EMAIL is the hardcoded literal
   "k.prathab@gmail.com". userHasPermission() grants ALLOW_AUTOMATION only by matching
   this string; no role can grant it. Same file hardcodes
   FORBIDDEN_OUTBOUND_EMAIL_SENDERS = {"greywolf3plca@gmail.com"} (~line 194).
   Move both to environment variables (AUTOMATION_OWNER_EMAIL,
   FORBIDDEN_OUTBOUND_SENDERS as a comma-separated list) read through the existing
   readEnv() helper. Add them to .env.example. Keep the current values as fallback
   defaults so nothing breaks on deploy. Also update AI_AUTOMATION_POLICY_TEXT
   (~line 348) to interpolate the env value instead of embedding the address.
```

---

## Task 4 — Add CSP, HSTS, and close the CSRF hole

```
applySecurityHeaders() at server.js:988 sets X-Content-Type-Options, X-Frame-Options,
Referrer-Policy, Permissions-Policy, X-Robots-Tag. It does not set Content-Security-Policy
or Strict-Transport-Security.

1. Add Strict-Transport-Security (max-age=31536000; includeSubDomains) — only when
   isSecureRequest(req) is true, so local HTTP dev is unaffected.

2. Add Content-Security-Policy. IMPORTANT: index.html, portal.html, mobile-pick.html,
   mobile-count.html and login.html each contain one enormous inline <script> and inline
   <style> blocks. A strict CSP will break all of them. Therefore:
   - Ship CSP in Content-Security-Policy-Report-Only mode first, not enforcing.
   - Write the policy as it WOULD look enforced (no unsafe-inline), so the report tells
     us exactly what breaks.
   - Do not attempt to extract the inline scripts. That is a separate, much larger job.
   Tell me in your summary what a real enforcing CSP would require.

3. requireSameOriginForStateChanges() at server.js:1011 returns next() when the Origin
   header is absent (line 1014), and the whole check is skipped when !IS_PRODUCTION.
   - Keep allowing absent-Origin for the endpoints that legitimately have no browser
     origin: the Stripe webhook, /api/print-agent/*, and /api/healtea/v1/*. Allowlist
     them explicitly by path.
   - For every other state-changing route, treat a missing Origin as a failure when the
     request carries a session cookie.
   - Verify against security-hardening.spec.js and add cases for the new behavior.

Do not add helmet or any new dependency. Extend the existing function.
```

**Note:** step 2 is deliberately report-only. Anyone who tells you they can add an enforcing CSP to a page with 19,500 lines of inline JS in one pass is going to break your app.

---

## Task 5 — Shopify API resilience

```
The Shopify lanes in server.js have no rate-limit handling. Grep confirms zero references
to 429, Retry-After, or X-Shopify-Shop-Api-Call-Limit anywhere in the file. A throttled
response falls through to the generic !response.ok branch and is thrown as a 502
(~line 12208). There is no backoff.

Also: fetchShopifyOrdersForIntegration (~line 12141) paginates via the Link rel="next"
header but hard-caps at 8 pages of 250 (~line 12187). Orders past 2,000 in a single run
are silently dropped — no warning, no cursor persisted.

Do this:
1. Add a shared retry wrapper for Shopify fetch calls that handles HTTP 429 by honoring
   the Retry-After header, with exponential backoff and a bounded number of attempts.
   Existing calls already use AbortSignal.timeout(30000) — preserve that.
2. Read X-Shopify-Shop-Api-Call-Limit and slow down proactively as the bucket fills.
3. When the 8-page cap is hit, do not silently stop. Either persist a cursor and resume
   on the next run, or set last_sync_status='WARNING' with a message naming the cap.
   State which you chose and why.
4. Tests: mock global.fetch to return 429 with Retry-After and assert the retry happens;
   assert the page cap produces a WARNING rather than a silent SUCCESS.

Do not change the import/idempotency logic in this task — that is Task 2's territory.
```

---

## Task 6 — Repo cleanup (send last, review carefully)

```
These files are unreferenced anywhere in the repo. I have verified this by grep across
all html/js/json files including server.js. They are extraction snapshots of index.html's
inline script and old backups. Combined, ~2.7 MB, and they currently ship to Railway
because .railwayignore does not exclude them.

Delete:
  _inline.js, _check_inline_tmp.js, inline_check.js, tmp_inline_check.js,
  index_extracted.js, check_index.js
  index.html.bak, server.js.bak, portal.html.bak
  portal.js            (dead — a stale copy of portal.html's inline script)
  "LocationsScanSaveCMV (3).html"

Do NOT delete site.html — it IS served, by sendMarketingPage() at server.js:5947.

Then:
1. Before deleting, re-verify each file is unreferenced. Report anything I got wrong.
2. Add *.bak and the temp-extraction pattern to .gitignore.
3. Run `npm test` after deletion to confirm nothing imported them.

Separately: the marketing pages exist in three places. Root and marketing/ are
byte-identical. bluehost-site/ differs only in absolute vs relative portal links.
Do not fix this yet — just tell me what a single-source build step would look like.
```

---

## What to watch for in Codex's output

- **A diff much larger than the task.** Task 3 is maybe 30 lines. If it comes back with 800, it reformatted something.
- **Claims of verification without a test run.** Ask for the actual `npm test` output.
- **New dependencies you didn't approve.** Especially `helmet`, `express-rate-limit`, an ORM, or anything that wants to restructure `server.js`.
- **"I also fixed…"** — revert it and re-scope. Unrequested fixes in a 31k-line file are where regressions hide.

## What NOT to ask Codex to do

- Split `server.js` into modules. Not yet, and not without tests covering the seams.
- Extract the inline JS from `index.html`. Same reason.
- Migrate the frontend to a framework.
- Replace the in-memory login rate limiter (`server.js:1027`) with a Redis-backed one — this has the same single-instance root cause as Task 2, but it's worth fixing only once you actually run more than one instance. Note it, don't build it.
