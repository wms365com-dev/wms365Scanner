# WMS365 Scanner Android Hybrid Architecture

## Decision

WMS365 Scanner uses a Kotlin Android WebView shell around the hosted WMS365 mobile/PWA experience.

The mobile web app remains the source of truth for screens, layout, workflow order, validation, and API behavior. Android adds device capabilities through a small JavaScript bridge exposed as `window.WMS365Android`, with the browser-safe wrapper in `/mobile-bridge.js` exposed as `window.WMS365Mobile`.

Trusted Web Activity was not chosen for the current build because the warehouse workflows need tighter control over camera/file handling, native scanner launch, WebView navigation, haptics, device identity, loading/offline screens, and future hardware integrations.

## Shared UI Model

- Mobile web routes remain the main experience:
  - `/mobile?mode=mobile`
  - `/mobile-count`
  - `/mobile-pick`
- Android loads the same hosted routes and CSS.
- Android-only UI is limited to splash/loading, offline/error state, scanner overlay/intent, permissions, and future native settings.
- Workflow changes should normally be made in the mobile web/PWA first, then deployed. Android receives the updated UI without rebuilding unless native bridge behavior changes.

## Native Bridge Contract

Browser pages should call `window.WMS365Mobile`, not `window.WMS365Android` directly.

Current shared methods:

- `isAndroidApp()`
- `getDeviceId()`
- `getSource()` returns `android_app` or `mobile_web`
- `getPlatform()`
- `getAppVersion()`
- `getAuditContext(actionType)`
- `envelope(payload, actionType)`
- `scanBarcode(targetId)`
- `vibrate(ms)`
- `beep(type)`
- `setKeepAwake(enabled)`
- `isOnline()`
- `clearWebData()`
- `queueTransaction(...)`, `getQueuedTransactions()`, `syncQueue()`

Every mobile transaction should include the audit envelope where the endpoint can accept it:

```js
const body = window.WMS365Mobile?.envelope?.(payload, "MOBILE_PICK_MARK_PICKED") || payload;
```

The payload includes `device_id`, `source`, `action_type`, `client_timestamp`, `platform`, and `app_version`. Backend endpoints can store these fields as audit columns as they are expanded.

## Implemented Native Capabilities

- Kotlin Android Studio project under `/android-app`
- Package name `com.wms365.app`
- App name `WMS365 Scanner`
- Secure WebView with HTTPS-only WMS365 domain whitelist
- Camera permission
- File/photo upload support
- Native ZXing barcode/QR scan handoff
- Android back button behavior
- Loading and offline/error screens
- Device ID bridge
- App version bridge
- Haptic and sound feedback bridge
- Keep-screen-awake bridge for active count/pick workflows
- Deep links for mobile routes

## PWA Support

- `/site.webmanifest` starts at `/mobile?mode=mobile`
- `/sw.js` caches the mobile shell, login, picker/count pages, manifest, logo, and bridge
- API routes are intentionally network-first and are not cached by the service worker
- Offline transaction queuing remains page/API specific today, with shared queue helpers available in `/mobile-bridge.js`

## Offline Strategy

Current production-safe behavior:

- Inventory Count has a dedicated IndexedDB queue and syncs pending counts back to `/api/inventory-counts` when online.
- The shared bridge has a generic offline queue foundation for future picks, receives, moves, and counts.
- Each queued transaction should carry an idempotency key or local transaction ID before backend posting is expanded for all workflows.

Recommended backend expansion:

- Add `/api/mobile/sync` for batched queued mobile transactions.
- Store `device_id`, `source`, `action_type`, `client_timestamp`, `user_id`, `company_id`, and `warehouse_id`.
- Add a unique `client_transaction_id` to prevent duplicate submissions.
- Return per-item sync results: `SYNCED`, `FAILED`, `CONFLICT`.

## Build APK

```powershell
cd C:\WMS365Scanner\android-app
.\build-debug.ps1 https://app.wms365.co
```

APK output:

```text
C:\WMS365Scanner\android-app\app\build\outputs\apk\debug\app-debug.apk
```

## Install On Connected Device

```powershell
cd C:\WMS365Scanner\android-app
.\install-debug.ps1 https://app.wms365.co
```

Verify device connection:

```powershell
C:\WMS365Scanner\.android-build-tools\android-sdk\platform-tools\adb.exe devices
```

Launch app:

```powershell
C:\WMS365Scanner\.android-build-tools\android-sdk\platform-tools\adb.exe shell am start -W -n com.wms365.app/.MainActivity
```

## Deployment

1. Deploy web/mobile/PWA changes to Railway.
2. Confirm `/api/version` shows the new git ref.
3. Test `/mobile?mode=mobile` in a mobile browser.
4. Reopen Android app and confirm it receives the same mobile UI.
5. Rebuild/reinstall Android only when native Kotlin, permissions, app config, or bridge methods change.

## Testing Checklist

- Login opens mobile workspace, not desktop.
- Company selector appears after login and stays locked.
- Back/switch company unlocks the company when needed.
- Pending button opens assigned work by age/SLA.
- Picking opens from pending task with company and order preselected.
- Location/SKU/lot scan buttons work with Android camera scanner.
- Hardware scanner input works when focus is in the expected field.
- Successful scan gives haptic/sound feedback.
- Failed validation gives error sound and keeps focus on the bad field.
- Inventory count allows unknown location/SKU with a light warning.
- Exception count recommends a photo and supports camera upload.
- Inventory count saves online as pending for desktop review.
- Inventory count queues offline and syncs after reconnect.
- Android back button steps through page history before exiting.
- App shows a usable offline/error state when the server cannot load.
- Mobile Chrome/Safari still work without Android bridge methods.

## Future Scaling

- Add Room/SQLite native sync storage if WebView IndexedDB is not enough for heavy offline work.
- Add batched `/api/mobile/sync` with idempotency and conflict review.
- Add Firebase Cloud Messaging for assigned work notifications.
- Add Bluetooth scanner and Zebra DataWedge integrations.
- Add warehouse printer integrations.
- Add voice picking.
- Add kiosk mode and MDM policy support.
- Add biometric login or secure re-auth after token/session support is formalized.
- Migrate isolated high-value flows to native Compose only when the shared PWA route cannot meet performance or hardware needs.
