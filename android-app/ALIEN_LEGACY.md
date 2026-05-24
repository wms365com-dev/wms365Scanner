# WMS365 Alien Legacy Scanner

This build is only for Alien ALR-H450 / Android 4.4.2 handhelds.

It is intentionally not the full WMS365 Android app. The modern app in `:app`
requires Android 8+ and includes newer native features such as camera scanning,
document cleanup/OCR support, modern file handling, and newer Android WebView
behavior.

The Alien legacy build is a lightweight WebView shell around the shared WMS365
mobile web app.

## What It Supports

- Android 4.4.2 / API 19 install
- Shared WMS365 mobile web routes
- Company selection and mobile warehouse workflows from the web app
- Alien barcode scanner as keyboard-wedge input
- Large touch workflow screens from the shared mobile UI
- Keep-screen-awake during warehouse work
- Basic vibration feedback when available
- USB or Wi-Fi ADB testing when the device is authorized

## What It Does Not Support

- Native camera barcode scanning
- Native document scanner / CamScanner-style cleanup
- ML Kit OCR
- Modern Android secure storage APIs
- Advanced Android offline queue storage beyond what the web app can support
- Push notifications
- Newer Android WebView features unavailable on Android 4.4.2

## Build

```powershell
cd C:\WMS365Scanner\android-app
.\build-alien-legacy.ps1 https://app.wms365.co
```

APK output:

```text
C:\WMS365Scanner\android-app\alienLegacy\build\outputs\apk\debug\alienLegacy-debug.apk
```

## Install

Use the Alien serial or wireless ADB target:

```powershell
C:\WMS365Scanner\.android-build-tools\android-sdk\platform-tools\adb.exe -s CW1806010056 install -r C:\WMS365Scanner\android-app\alienLegacy\build\outputs\apk\debug\alienLegacy-debug.apk
```

or:

```powershell
C:\WMS365Scanner\.android-build-tools\android-sdk\platform-tools\adb.exe -s 192.168.0.201:5555 install -r C:\WMS365Scanner\android-app\alienLegacy\build\outputs\apk\debug\alienLegacy-debug.apk
```

## Scanner Test

1. Open WMS365 Alien Scanner.
2. Select a company.
3. Open Inventory Count or Picking.
4. Tap a scan field or Trigger.
5. Press the Alien barcode scan trigger.
6. Confirm the scanned value lands in the active field and Enter advances the flow.

