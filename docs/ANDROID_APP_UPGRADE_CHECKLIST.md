# Android App Upgrade Checklist

Review date: 2026-09-17

The existing `com.wms365.app` hosted-mobile Android app is the first upgrade target. The separate `nativeScanner` prototype and legacy Alien application are not replaced or certified by this upgrade. Confirm which installed application and testing service are in use before distribution.

## Initial Upgrade: 0.2.38 / Build 39

## Focused Warehouse Actions Candidate: 0.3.0 / Build 40

Built 2026-10-15 for `https://app.wms365.co/mobile/warehouse`. The hosted Android shell now opens the focused Receive/Ship workspace and returns there from native pick/count back navigation. The exact route was added to the native deep-link allowlist; deceptive origins and non-mobile paths remain blocked.

Local acceptance: six Android source-security guards, four JVM URL-policy tests, and four warehouse-action route/behavior tests passed. The debug APK is v2-signed for controlled device testing, and a release AAB was generated for final signing/upload. Authenticated receive and ship behavior was separately verified against pinned test company account `1510`; no live customer transaction was created for this Android build. Physical-device camera, upload, scanner-trigger, upgrade, and screen-layout acceptance remain release gates.

| Change | Customer value | Warehouse value | Risk / dependency | Acceptance |
| --- | --- | --- | --- | --- |
| High: exact configured HTTPS origin | Protect account access | Keep scanner permissions on the trusted WMS site | Staging must have its own explicit HTTPS origin; external links stay outside the app | Reject deceptive hosts, credentials in URLs, custom ports, insecure schemes and non-mobile deep links |
| High: camera permission scoping | Limit device access | Retain camera barcode and document scanning | Runtime camera permission; no microphone grants | Allow trusted camera request; deny untrusted origins and unrelated resources; cancel stale requests |
| High: visible load and access failures | Clear recovery instructions | Reduce repeated actions and confusing server pages | Device date/time and connection quality | Test 401, 403, 429, 5xx, invalid TLS and main-frame versus asset failures |
| High: safe scan callback arguments | Preserve accurate item identifiers | Handle unusual barcode characters safely | Hosted mobile bridge remains backward compatible | Scan quotation marks, backslashes, line breaks and GS1 separators without script errors |
| High: screen-crash recovery | Retain saved work | Reopen the workspace without erasing offline queues | Android WebView process recovery | Recover after renderer failure; verify server status before repeating transactions |

Code and build checks are not a substitute for installed-app acceptance. No production transaction is required to build this version.

## Next Test-Account Work

| Priority | Work | Acceptance |
| --- | --- | --- |
| Critical | Shared-device session and offline-cache ownership | Another customer/warehouse/user cannot read previous cached work or submit another user's queue |
| High | Native bridge frame-origin controls | Untrusted embedded frames cannot invoke native methods; inventory-count, pick and document bridges continue working |
| High | Scan-directed workflow usability | One clear next action; wrong location/SKU is visible immediately; manual entry remains available with normal controls |
| High | Offline conflict and duplicate handling | Reconnect sends each confirmation once; rejected/changed allocations require review rather than false completion |
| High | Hardware acceptance | Test camera, keyboard-wedge and the actual warehouse scanner trigger on supported devices |
| High | Upgrade distribution | Preserve package ID, production signing certificate and version ordering; pilot upgrade preserves queues and storage; no unsigned background APK replacement |
| Medium | Native prototype audit | Review logout cache retention, outbox ownership, redirects and permanent-error retries before any migration from the hosted app |

## Test Safety

### Firebase Preparation: 2026-09-17

- Installed Google Cloud CLI 585.0.0 locally from Google's versioned archive; its SHA-256 matched the published value. No paid plan or billing settings were changed.
- Migrated the synthetic instrumentation suite to AndroidX/JUnit 4. Both cloudTest APKs compiled, passed APK v2 signature verification, and the runner targets only `com.wms365.app.testlab`.
- Four JVM URL-policy tests and six Android source-security guards passed. The shared-system suite passed 463 tests. These are local results, not device results.
- Six on-device smoke tests are prepared, with three diagnostic screenshots for offline, HTTP and renderer recovery. Tests fail before launching the activity unless both the app identity and reserved `.invalid` backend match.
- Google authorization completed and project billing was verified disabled. Firebase synthetic smoke execution and screenshot review completed on 2026-09-17; installed-app business acceptance remains incomplete.
- Authenticated order, inbound, movement and offline-sync acceptance remains a separate test-company phase using owner account `1510`; no live company may be used as a fallback.

### Firebase Results: 2026-09-17

Final matrix: `matrix-16y2nonsbj9ew`. [Firebase results](https://console.firebase.google.com/project/wms365/testlab/histories/bh.8e4d009f7238d7d5/matrices/4654868977362042758).

| Virtual device | Android | WebView | Result |
| --- | --- | --- | --- |
| MediumPhone.arm, portrait, English | 8.0 / API 26 | 58.0.3029.125 | 6 passed, 0 failures/errors/skips |
| MediumPhone.arm, portrait, English | 15 / API 35 | 124.0.6367.219 | 6 passed, 0 failures/errors/skips |

- Scope: separate package `com.wms365.app.testlab`, version `0.2.38-secure-recovery-isolated` / build 39, backend `https://wms365-test.invalid`. No live credentials, customer records or production transactions were used.
- Checks cover connection-failure recovery, simulated main-frame HTTP errors versus asset errors, denied untrusted camera/microphone requests, trusted-origin deep links, exact barcode callback characters, and simulated renderer replacement with late retired-screen callbacks. These tests do not certify actual offline sync, physical scanning, trusted runtime camera grants or real process crashes.
- Added retired-WebView guards so queued page/error callbacks cannot replace the current screen's recovery state. Certificate errors are always cancelled, including retired-screen requests.
- Early screenshots captured previous display frames despite passing view-state assertions. The test helper now waits for redraw, accessibility idleness and window settling; HTTP/renderer state is asserted again after capture. Intermediate screenshots are not accepted as final visual evidence.
- Reviewed all six final connection/HTTP/renderer screenshots: messages and controls are readable, not clipped or overlapping. Evidence: `outputs/android-device-tests/display-r5/api26/` and `api35/`, including native result XMLs and three PNGs per device.
- Final app SHA-256: `ED6D750BC7AA392633894981808F599732CE46AB668EE871804E74FA20E0FC32`. Final instrumentation SHA-256: `52AAA00C326BE443A094632421B4A339122564E047B2B8A09CE2A8877A0F05D3`. Both test APK v2 signatures verified; these are not production signing certificates.
- Four JVM tests, six Android source guards and all 463 shared-system tests passed. The final instrumentation-only display-wait adjustment also passed all six source guards and both device runs.
- Eight virtual-device executions were used across successful matrices; the initial invalid-target request was rejected before a matrix started. No billing/paid-plan settings were changed, no release was deployed, and no APK was distributed.
- Release remains blocked on shared-device cache ownership, native bridge frame-origin isolation, authenticated test-company workflows, physical scanner/offline-conflict acceptance and production signing/update rollout checks.

### Transaction Test Guardrails

- Use the designated WMS365 test company for all orders, receiving, picking, moves and counts.
- Designated identity: `CODEX PORTAL SYSTEM TEST`, owner account ID `1510`, verified read-only on 2026-09-17. Check exact identity and active status using `scripts/designated-test-company.js`; no other Codex/test account is a fallback. Offline synthetic cloud smoke tests do not need a live account.
- A test login alone is insufficient if it can select live customer companies.
- Live customer verification is read-only unless a real business transaction is explicitly requested.
- Do not send live customer data or credentials to competitors or public research sites.
- A cloud device-testing provider needs separate approval for any upload containing business data. Prefer synthetic test-company records.
- Record actual device model, OS/WebView version, app package/version, test identity scope and screenshots before marking device acceptance complete.

## Official References

Reviewed 2026-09-16:

- Android native-bridge security: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges
- Android unsafe URI loading: https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading
- ShipHero mobile picking guide: https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-ShipHero-iOS-Mobile-App
- ShipHero location-directed QR picking: https://software-help.shiphero.com/hc/en-us/articles/16985098558861-How-to-Use-Bulk-Ship-with-QR-Code-Picking
- Extensiv SmartScan: https://www.extensiv.com/3pl/products/smartscan

Competitor documentation supports workflow patterns, not proof of their security implementation or offline behavior. This checklist uses WMS365's existing design and does not copy competitor layouts or code.
