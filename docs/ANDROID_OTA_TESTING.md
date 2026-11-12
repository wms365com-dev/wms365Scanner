# Android OTA Updates And Testing

WMS365 Android has two independent update paths for both `com.wms365.warehouse` and `com.wms365.customerportal`.

1. Hosted mobile workflows load from `https://app.wms365.co/mobile?mode=mobile`. A normal server deployment updates those screens without publishing a new Android build.
2. Native shell, camera, scanner, and device-bridge changes ship as signed Android App Bundles through Google Play. Build 45 prefers Play's immediate update flow, resumes interrupted updates, and reopens the update after cancellation. Flexible update is retained only as a compatibility fallback when Play does not permit an immediate update.

## Internal testing setup

1. Maintain separate Play applications for `com.wms365.warehouse` and `com.wms365.customerportal`.
2. Enable Play App Signing and register the existing WMS365 upload certificate.
3. Open **Test and release > Testing > Internal testing** and add only approved warehouse testers.
4. Upload each signed bundle from `outputs/android-play` to its matching Internal testing track.
5. Share the generated opt-in link. Testers must install from that Play link; a sideloaded APK cannot exercise Play-managed updates.

## OTA acceptance test

1. Install the prior version from each Internal testing opt-in link and sign in only to `CODEX PORTAL SYSTEM TEST` (owner account ID 1510).
2. Confirm the mobile menu, Picking, Receiving, Inventory Count, camera, and barcode scanning open without creating live-company transactions.
3. Publish a higher version code to the same Internal testing track.
4. Open the prior build and confirm the immediate Play update flow appears automatically.
5. Cancel once and confirm the app reopens the required update. Complete the update.
6. Confirm the higher version is installed and the authenticated session and offline queue are intact.
7. Repeat negative checks: no live customer is selected, no email is sent, no carrier purchase occurs, and no Shopify or billing write occurs.

Google Play does not permit downgrading to a lower version code. A rollback release must restore the prior behavior in a newly signed bundle with a higher version code.
