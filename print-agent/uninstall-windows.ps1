param([switch]$RemoveData)

$ErrorActionPreference = "Stop"
$installPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolvedInstallPath = [IO.Path]::GetFullPath($installPath)
$marker = Join-Path $installPath "installed.json"
if (-not (Test-Path -LiteralPath $marker)) { throw "This is not an installed WMS365 Print Connector. Uninstall stopped." }
$installation = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
if ($installation.installPath -ne $resolvedInstallPath -or $resolvedInstallPath -eq [IO.Path]::GetPathRoot($resolvedInstallPath)) { throw "Unsafe uninstall target. Uninstall stopped." }
$scriptPath = Join-Path $installPath "wms365-print-agent.js"
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($scriptPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath("Desktop")) "WMS365 Print Agent.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath("Startup")) "WMS365 Print Agent.lnk") -Force -ErrorAction SilentlyContinue

$cleanup = Join-Path $env:TEMP ("wms365-print-agent-uninstall-" + [guid]::NewGuid().ToString("N") + ".ps1")
$dataPath = Join-Path $env:LOCALAPPDATA "WMS365 Print Agent Data"
$resolvedDataPath = [IO.Path]::GetFullPath($dataPath)
if (-not $resolvedDataPath.StartsWith([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe data cleanup path." }
$escapedInstallPath = $installPath.Replace("'", "''")
$escapedDataPath = $dataPath.Replace("'", "''")
$cleanupLines = @(
    "Start-Sleep -Seconds 2",
    "Remove-Item -LiteralPath '$escapedInstallPath' -Recurse -Force -ErrorAction SilentlyContinue"
)
if ($RemoveData) {
    $cleanupLines += "Remove-Item -LiteralPath '$escapedDataPath' -Recurse -Force -ErrorAction SilentlyContinue"
}
$cleanupLines += "Remove-Item -LiteralPath '$cleanup' -Force -ErrorAction SilentlyContinue"
Set-Content -LiteralPath $cleanup -Value $cleanupLines -Encoding UTF8
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $cleanup)
Write-Host "WMS365 Print Agent was removed." -ForegroundColor Green
