# WMS365 Android Apps

The project builds two independently installable native shells:

- `warehouse`: package `com.wms365.warehouse`, opening the mobile warehouse workspace.
- `customerPortal`: package `com.wms365.customerportal`, opening `/portal.html` with portal-only top-level navigation.

Both variants share the hardened WebView, uploads, document scanner, barcode support, and Google Play flexible updates. They use separate Play Store listings and can coexist on one device.

## Upgrade Candidate: 0.3.3

Build 41 opens the complete warehouse mobile workspace at `/mobile?mode=mobile` while retaining trusted-origin validation, camera permission scoping, HTTP/TLS error messages, renderer recovery and safe barcode/document callbacks. The focused Receive/Ship workspace remains available from the full menu. This is a distribution candidate, not a production-store announcement. Device acceptance and the existing production signing certificate are still required.

The upgrade and remaining acceptance checklist is in `docs/ANDROID_APP_UPGRADE_CHECKLIST.md` at the repository root. Use the designated test company for transaction testing, never a live customer company.

The hosted-mobile app (`com.wms365.app`), native prototype (`nativeScanner`) and Alien legacy module are separate applications. This candidate upgrades only the hosted-mobile app.

This is a dedicated Android shell for the WMS365 mobile warehouse flow.

For the full architecture, bridge contract, deployment notes, and test checklist, see:

`C:\WMS365Scanner\docs\ANDROID_HYBRID_ARCHITECTURE.md`

## Chosen Approach

WMS365 uses a native Android WebView shell around the hosted mobile web app. This keeps the mobile web/PWA frontend as the single source of truth, while still allowing Android-only behavior such as camera permission handling, file/photo upload, persistent device storage, native barcode scan handoff, haptics, sound feedback, loading/error screens, and approved-domain navigation controls.

Trusted Web Activity was not chosen for this build because the warehouse flow benefits from deeper device features and tighter WebView controls.

## What It Does

- Opens the complete WMS365 mobile task menu directly at `/mobile?mode=mobile`.
- Includes the mobile features exposed by the WMS365 mobile menu, including receive, lookup, adjust, inventory count, inbound arrival, pallets, and picking.
- Does not bundle a separate copy of the mobile screens. When WMS365 mobile web screens change on the server and are deployed, Android gets the same updated screens.
- Uses Google Play flexible in-app updates for signed native releases. Testers installed from the Internal testing track can download an update while continuing warehouse work, then approve an app restart to install it.
- The web app can manually request a native update check with `window.WMS365Android.checkForUpdates()`.
- Uses Android WebView persistent storage, so company lock, cached master data, and offline counts remain on the device.
- Grants camera access for barcode scanning and supports a native Android barcode handoff for pages that call `window.WMS365Android.scanBarcode(...)`.
- Supports the camera/photo picker for exception photos.
- Works with the web page's IndexedDB offline queue. If connectivity drops, counts are saved locally and sync automatically when the device comes back online.
- Restricts WebView navigation to approved HTTPS WMS365 domains.
- Supports Android deep links for `/mobile`, `/mobile-count`, and `/mobile-pick`.
- Exposes native device features through the shared `/mobile-bridge.js` wrapper so mobile web and Android stay in sync.

## Update Model

The Android app is intentionally a thin native shell around the hosted WMS365 mobile workspace. Most workflow/UI changes should be made in the WMS365 web app and deployed normally. The Android shell only needs a rebuild when native behavior changes, such as permissions, app name/icon, file upload handling, camera access, the server base URL, or the startup path.

## Build And Test

1. Install Android Studio.
2. Open this folder: `C:\WMS365Scanner\android-app`.
3. Set the server URL in `gradle.properties`:

   ```properties
   WMS365_BASE_URL=https://app.wms365.co
   ```

   Cleartext HTTP is intentionally rejected. Local connected testing needs a trusted HTTPS test origin.

4. Connect an Android phone with USB debugging enabled, or start an emulator.
5. Run the `app` configuration from Android Studio.

Command-line build once Android Studio/JDK and Gradle are installed:

```powershell
gradle assembleWarehouseDebug assembleCustomerPortalDebug -PWMS365_BASE_URL=https://app.wms365.co -PWMS365_START_PATH=/mobile?mode=mobile
```

Command-line build using the local toolchain installed in this repo:

```powershell
.\build-debug.ps1 https://app.wms365.co
```

The debug APK will be under `app\build\outputs\apk\debug\`.

### Isolated Firebase Device Tests

Build the app and instrumentation APKs with `:app:assembleCloudTest :app:assembleCloudTestAndroidTest :app:testCloudTestUnitTest -PWMS365_TEST_BUILD_TYPE=cloudTest`. The cloudTest build uses package `com.wms365.app.testlab` and reserved origin `https://wms365-test.invalid`; it cannot connect to the production backend. Six synthetic tests cover offline recovery, HTTP errors, untrusted camera/audio requests, deep-link origin limits, barcode characters and renderer recovery.

Screenshots are saved on the device under `/sdcard/Android/data/com.wms365.app.testlab/files/wms365-test-artifacts`. Include that directory with Firebase's `--directories-to-pull` option. These smoke tests contain no customer login or business transactions and do not replace authenticated test-company workflow acceptance.

To build and install on a connected Android device with USB debugging enabled:

```powershell
.\install-debug.ps1 https://app.wms365.co
```

## Offline Test

1. Open the app while online and sign in.
2. Open Inventory Count from the mobile menu, select company, and start a count.
3. Turn off Wi-Fi/cellular.
4. Save a count.
5. Confirm the app says the count was saved on this device.
6. Turn connectivity back on.
7. Confirm the queued count syncs and appears on the desktop Inventory Count Review screen.

## Testing Checklist

- Login: sign in with a warehouse user and confirm `/mobile?mode=mobile` opens the mobile task menu, not desktop.
- Company lock: choose a company, confirm it stays locked, then use Back to switch company.
- Pending work: tap Pending and confirm open work is listed by age/SLA and opens the right workflow.
- Scanning: test camera barcode scan, manual key-in, and hardware scanner keyboard input.
- Receiving: receive/stage a line and confirm the active company is applied.
- Picking: open mobile picking, select an order, confirm location/SKU/lot/expiry fields.
- Bin moves/adjustments: open Adjust and confirm the selected company carries through.
- Inventory count: scan/key in location and SKU, save online, then save once while offline.
- Reconnect sync: restore network and confirm queued counts sync once without duplicates.
- Permissions: deny and allow camera permission; confirm the app falls back to key-in if needed.
- Android back button: confirm it steps back through WebView history before exiting.
- Mobile browser compatibility: repeat login/company/pending/count in Chrome or Safari mobile.
