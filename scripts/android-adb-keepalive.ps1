param(
    [string]$Address = "172.20.10.13:5555",
    [string]$AdbPath = "C:\WMS365Scanner\.android-build-tools\android-sdk\platform-tools\adb.exe",
    [int]$IntervalSeconds = 20,
    [string]$LogPath = "C:\WMS365Scanner\test-results\android-adb-keepalive.log"
)

$ErrorActionPreference = "Continue"

function Write-KeepAliveLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    $directory = Split-Path -Parent $LogPath
    if ($directory -and !(Test-Path $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value $line
}

if (!(Test-Path -LiteralPath $AdbPath)) {
    throw "ADB not found at $AdbPath"
}

Write-KeepAliveLog "Starting ADB keepalive for $Address"

while ($true) {
    try {
        $devices = & $AdbPath devices
        $isConnected = $devices -match [regex]::Escape($Address)
        if (-not $isConnected) {
            $connectOutput = & $AdbPath connect $Address 2>&1
            Write-KeepAliveLog "connect $Address => $connectOutput"
        }

        $state = & $AdbPath -s $Address get-state 2>&1
        if ($state -match "device") {
            & $AdbPath -s $Address shell input keyevent KEYCODE_WAKEUP | Out-Null
            Write-KeepAliveLog "$Address alive"
        } else {
            Write-KeepAliveLog "$Address not ready: $state"
        }
    } catch {
        Write-KeepAliveLog "Error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $IntervalSeconds
}
