$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $repoRoot ".android-build-tools\android-sdk\platform-tools\adb.exe"
$apk = Join-Path $PSScriptRoot "nativeScanner\build\outputs\apk\debug\nativeScanner-debug.apk"

if (!(Test-Path $adb)) { throw "Missing adb at $adb." }
if (!(Test-Path $apk)) {
    & (Join-Path $PSScriptRoot "build-native-scanner.ps1")
}

& $adb devices -l
& $adb install -r $apk
