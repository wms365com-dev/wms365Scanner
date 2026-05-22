# WMS365 Android Mobile App

This is a dedicated Android shell for the WMS365 mobile warehouse flow.

## What It Does

- Opens the WMS365 mobile workspace directly at `/mobile`.
- Includes the mobile features exposed by the WMS365 mobile menu, including receive, lookup, adjust, inventory count, inbound arrival, pallets, and picking.
- Does not bundle a separate copy of the mobile screens. When WMS365 mobile web screens change on the server and are deployed, Android gets the same updated screens.
- Uses Android WebView persistent storage, so company lock, cached master data, and offline counts remain on the device.
- Grants camera access for barcode scanning when Android WebView supports it.
- Supports the camera/photo picker for exception photos.
- Works with the web page's IndexedDB offline queue. If connectivity drops, counts are saved locally and sync automatically when the device comes back online.

## Update Model

The Android app is intentionally a thin native shell around the hosted WMS365 mobile workspace. Most workflow/UI changes should be made in the WMS365 web app and deployed normally. The Android shell only needs a rebuild when native behavior changes, such as permissions, app name/icon, file upload handling, camera access, the server base URL, or the startup path.

## Build And Test

1. Install Android Studio.
2. Open this folder: `C:\WMS365Scanner\android-app`.
3. Set the server URL in `gradle.properties`:

   ```properties
   WMS365_BASE_URL=https://your-live-wms365-domain.com
   ```

   For a local server from an Android emulator, use:

   ```properties
   WMS365_BASE_URL=http://10.0.2.2:3000
   ```

4. Connect an Android phone with USB debugging enabled, or start an emulator.
5. Run the `app` configuration from Android Studio.

Command-line build once Android Studio/JDK and Gradle are installed:

```powershell
gradle assembleDebug -PWMS365_BASE_URL=https://your-live-wms365-domain.com -PWMS365_START_PATH=/mobile
```

Command-line build using the local toolchain installed in this repo:

```powershell
.\build-debug.ps1 https://your-live-wms365-domain.com
```

The debug APK will be under `app\build\outputs\apk\debug\`.

To build and install on a connected Android device with USB debugging enabled:

```powershell
.\install-debug.ps1 https://your-live-wms365-domain.com
```

## Offline Test

1. Open the app while online and sign in.
2. Open Inventory Count from the mobile menu, select company, and start a count.
3. Turn off Wi-Fi/cellular.
4. Save a count.
5. Confirm the app says the count was saved on this device.
6. Turn connectivity back on.
7. Confirm the queued count syncs and appears on the desktop Inventory Count Review screen.
