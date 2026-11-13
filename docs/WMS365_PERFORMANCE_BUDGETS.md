# WMS365 Performance Budgets

Reviewed: 2026-11-12

WMS365 uses McMaster-Carr as a workflow-speed reference, not as a source of code, copy, layout, or protected assets. The target behavior is immediate search focus, stable dense lists, minimal full-screen refreshes, and fast record drill-in.

## Initial Budgets

| Workflow | Target | Blocking threshold |
| --- | ---: | ---: |
| Signed-in application shell | 1,000 ms median | 1,500 ms p95 |
| Sales-order queue API, warm sandbox | 750 ms median | 1,500 ms maximum |
| Client-side queue filter feedback | 100 ms | 250 ms |
| Order detail drill-in API | 500 ms median | 1,000 ms p95 |
| Status update acknowledgement | 750 ms median | 1,500 ms p95 |

## Release Rules

- Measure only with anonymized synthetic fixtures in the isolated customer sandbox or read-only production telemetry.
- Preserve tenant, company, warehouse, role, document, inventory, billing, email, integration, and audit boundaries.
- A speed improvement cannot remove correctness checks or broaden access.
- Targeted regression tests, access-control audit, deployment gate, fresh-database check, authenticated sandbox workflow, and a 10-minute healthy soak are mandatory before production promotion.
- Production promotion is blocked by failed budgets, readiness delays, restarts, unexplained warnings, dirty source state, or a mismatched artifact.

## Sales-Order Queue Phase 1

- Run independent list dependencies concurrently: order lines, document summaries, shipment lines, print summaries, inventory-pool flags, and temporary oversell policy flags.
- Preserve the existing JSON response shape and no-store behavior.
- Emit `Server-Timing: portal-orders` and `X-WMS365-Result-Count` for read-only verification.
- Verify the real authenticated endpoint with the exact designated test company and a warehouse-restricted test user.
