$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $repoRoot ".android-build-tools"
$adb = Join-Path $toolsRoot "android-sdk\platform-tools\adb.exe"
$apk = Join-Path $PSScriptRoot "app\build\outputs\apk\debug\app-debug.apk"

if (!(Test-Path $adb)) {
    throw "Missing adb at $adb. Re-run the Android toolchain setup."
}

& (Join-Path $PSScriptRoot "build-debug.ps1") @args

if (!(Test-Path $apk)) {
    throw "APK was not created at $apk."
}

& $adb devices
& $adb install -r $apk
