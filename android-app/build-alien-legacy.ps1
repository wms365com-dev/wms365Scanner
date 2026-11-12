$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $repoRoot ".android-build-tools"
$jdkHome = Join-Path $toolsRoot "jdk-17"
$androidSdk = Join-Path $toolsRoot "android-sdk"
$gradle = Join-Path $toolsRoot "gradle-8.7\bin\gradle.bat"

if (!(Test-Path $jdkHome)) {
    throw "Missing local JDK at $jdkHome. Re-run the Android toolchain setup."
}
if (!(Test-Path $androidSdk)) {
    throw "Missing local Android SDK at $androidSdk. Re-run the Android toolchain setup."
}
if (!(Test-Path $gradle)) {
    throw "Missing local Gradle at $gradle. Re-run the Android toolchain setup."
}

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:Path = "$jdkHome\bin;$androidSdk\platform-tools;$env:Path"

$baseUrl = if ($args.Count -gt 0) { $args[0] } else { "https://app.wms365.co" }

Push-Location $PSScriptRoot
try {
    & $gradle ":alienLegacy:assembleDebug" "-PWMS365_BASE_URL=$baseUrl" --no-daemon
} finally {
    Pop-Location
}
