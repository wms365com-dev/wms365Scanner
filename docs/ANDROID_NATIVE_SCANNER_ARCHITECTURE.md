# WMS365 Native Android Scanner Architecture

This is the production direction for rugged Android scanners such as the Chainway RS60.

## Decision

WMS365 now has a native Android scanner module at:

`C:\WMS365Scanner\android-app\nativeScanner`

This module is not a WebView. It contains local workflow state, a SQLite database, scanner handling, offline queueing, and sync logic on the device.

The existing WebView app remains in place during migration so current warehouse testing is not broken.

## Architecture

- UI: Kotlin Android views, optimized for rugged scanner screens.
- Local database: SQLite via `LocalStore`.
- Session storage: Android Keystore encrypted session cookie.
- Scanner input: hardware keyboard wedge, rugged device scan broadcasts, and camera fallback.
- Sync: foreground app sync plus Android `JobScheduler` network sync.
- Backend role: sends released orders and receives confirmations/exceptions.

## Local Tables

- `settings`: device id, encrypted session cookie, company lock.
- `pick_orders`: released order cache.
- `pick_tasks`: local pick route and state machine.
- `outbox`: pending confirmations/exceptions waiting to sync.
- `scan_history`: accepted/rejected scans for audit/debugging.

## Picking State Machine

`GO_TO_LOCATION -> SCAN_LOCATION -> SCAN_ITEM -> ENTER_QTY -> COMPLETE`

Exception path:

`GO_TO_LOCATION/SCAN_LOCATION/SCAN_ITEM/ENTER_QTY -> EXCEPTION`

Each task shows one required action at a time.

## Backend APIs Used

- `POST /api/app/login`
- `GET /api/mobile/pick-orders`
- `POST /api/mobile/pick-arrivals`
- `POST /api/mobile/pick-confirmations`
- `POST /api/mobile/pick-exceptions`

## Worker Flow

1. Sign in.
2. Company stays locked on the device.
3. App downloads released orders.
4. Worker selects an order.
5. App shows one location.
6. Worker scans or confirms location.
7. App unlocks SKU scan.
8. Worker scans SKU/UPC.
9. App unlocks picked quantity.
10. Worker confirms quantity or reports short pick.
11. App saves locally immediately.
12. Sync sends confirmations when online.

## Build

```powershell
$toolsRoot = "C:\WMS365Scanner\.android-build-tools"
$env:JAVA_HOME = Join-Path $toolsRoot "jdk-17"
$env:ANDROID_HOME = Join-Path $toolsRoot "android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
cd C:\WMS365Scanner\android-app
& "$toolsRoot\gradle-8.7\bin\gradle.bat" :nativeScanner:assembleDebug -PWMS365_BASE_URL=https://app.wms365.co --no-daemon
```

APK:

`C:\WMS365Scanner\android-app\nativeScanner\build\outputs\apk\debug\nativeScanner-debug.apk`

## Install On RS60

```powershell
C:\WMS365Scanner\.android-build-tools\android-sdk\platform-tools\adb.exe -s f19e40c install -r C:\WMS365Scanner\android-app\nativeScanner\build\outputs\apk\debug\nativeScanner-debug.apk
```

## Test Checklist

- Login with warehouse worker.
- Company lock persists after app restart.
- Released pick orders download.
- App opens order offline after cache.
- Location scan rejects wrong location.
- SKU/UPC scan rejects wrong item.
- Pick qty cannot exceed required qty.
- Short pick creates exception.
- Confirmations save while Wi-Fi is off.
- Outbox syncs when Wi-Fi returns.
- Hardware trigger inserts scanner data.
- Camera scan fallback works.
- JobScheduler sync sends queued transactions.

## Next Production Steps

- Add receiving, putaway, count, and move native modules using the same outbox.
- Add item/location/inventory snapshot endpoints for wider offline validation.
- Add supervisor exception approval queue on desktop.
- Add MDM configuration support for base URL, warehouse, and device profile.
- Add vendor SDK adapters where a scanner does not operate as keyboard wedge or broadcast scanner.
