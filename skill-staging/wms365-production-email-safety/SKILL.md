---
name: wms365-production-email-safety
description: Safely change, verify, or troubleshoot WMS365 production emails, including shipment confirmations, recipient privacy, To/CC/BCC rules, queued messages, and email-worker deployments.
---

# WMS365 Production Email Safety

Use this workflow whenever a WMS365 task can send or change a real customer, company, warehouse, billing, or operational email.

## Before External Effects

1. Identify the exact company, email type, recipient source, and whether the send is synchronous or queued.
2. Read the effective account preference and addressing rule. Preserve opt-outs and never mark a suppressed message `SENT`.
3. Inspect both the transaction producer and the background worker that performs the send. A correct local producer does not prove the live worker has the same code.
4. Before allowing a queued production email, verify the active deployment contains the intended addressing behavior. Compare the running deployment identity or inspect the behavior inside the live container without sending a message.
5. Stop before queueing or releasing the transaction if deployment parity is unknown, the worker is older, or recipient privacy cannot be proven.

## Recipient Privacy

- Treat multi-recipient customer or company notifications as privacy-sensitive.
- Use an account-scoped configuration or reusable addressing helper, not an order-specific branch, when the requirement applies to the whole company.
- For BCC-only accounts, use the approved WMS365 system address as the visible `To` recipient and place all customer/company recipients in `BCC`. Leave `CC` empty.
- Normalize the exact account identity before applying the rule. Add negative tests proving similarly named and unrelated companies are unaffected.
- Never expose real recipient addresses in test output, logs, screenshots, or user summaries. Use `.invalid` fixtures.

## Implementation And Tests

1. Keep recipient selection separate from To/CC/BCC placement so existing authorization and subscription filters remain intact.
2. Add tests for the requested company, multiple recipients, missing system recipient, and tenant isolation.
3. Run the targeted email tests and the repository's full deployment gate.
4. Do not deploy a dirty checkout containing unrelated failing work. Build a controlled snapshot from the active production deployment or another verified release base, then apply only the reviewed email change.

## Deployment Verification

1. Deploy through the normal Railway service and environment with the configured health gate; do not force-promote an unhealthy candidate.
2. Confirm the new deployment reaches `SUCCESS` and the public health endpoint reports ready.
3. Inspect the running container or an equivalent read-only production diagnostic and prove the exact company resolves to the intended `to`, `cc`, and `bcc` fields without sending an email.
4. Record the deployment ID and verification result. Do not claim the fix is live based only on local tests, upload completion, or a container starting.

## Incident Handling

- An already delivered email cannot be recalled through WMS365. State that plainly.
- Audit the actual sent-message envelope before diagnosing the cause.
- If local behavior and the sent envelope differ, check live deployment parity first.
- Explain misses in concrete control terms, such as an unverified worker version, and add the missing preventive gate before closing the incident.

