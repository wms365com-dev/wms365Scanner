param([string]$PackagePath = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Get-WmsFileSha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace("-", "") }
    finally { $stream.Dispose(); $hash.Dispose() }
}
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path (Split-Path -Parent $source) "outputs\print-connector"
if (-not $PackagePath) { $version = (Get-Content (Join-Path $source "package.json") -Raw | ConvertFrom-Json).version; $PackagePath = Join-Path $output "WMS365_Print_Connector_$version`_Windows_x64.zip" }
$smoke = Join-Path $output ("smoke-" + [guid]::NewGuid().ToString("N"))
$install = Join-Path $smoke "installed"
$child = $null
$keys = @("WMS365_PRINT_AGENT_DATA_DIR", "WMS365_PRINT_AGENT_PORT", "WMS365_APP_URL", "WMS365_PRINT_STATION_TOKEN")
$saved = @{}
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, "Process") }
try {
    Expand-Archive -LiteralPath $PackagePath -DestinationPath $smoke
    $package = Join-Path $smoke "WMS365 Print Connector"
    & (Join-Path $package "install-windows.ps1") -InstallPath $install -SkipShortcuts -NoStart
    if (-not (Test-Path -LiteralPath (Join-Path $install "installed.json"))) { throw "Installation marker missing." }
    if (-not (Test-Path -LiteralPath (Join-Path $install "tools\SumatraPDF.exe"))) { throw "PDF engine missing." }
    $node = (Get-Content -LiteralPath (Join-Path $install "node-path.txt") -Raw).Trim()
    foreach ($name in @("wms365-print-agent.js", "wms365-print-agent-core.js", "connector-dashboard.js", "connector-updater.js", "connector-security.js")) {
        & $node --check (Join-Path $install $name)
        if ($LASTEXITCODE -ne 0) { throw "Installed JavaScript failed verification: $name" }
    }
    $env:WMS365_PRINT_AGENT_DATA_DIR = Join-Path $smoke "data"
    $env:WMS365_PRINT_AGENT_PORT = "8855"
    $env:WMS365_APP_URL = "http://127.0.0.1:8857"
    $env:WMS365_PRINT_STATION_TOKEN = ""
    $child = Start-Process -FilePath $node -WindowStyle Hidden -WorkingDirectory $install -ArgumentList ('"{0}" --background' -f (Join-Path $install "wms365-print-agent.js")) -PassThru
    $page = $null
    for ($i = 0; $i -lt 50; $i++) {
        try { $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8855"; break } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $page -or $page.Content -notlike "*WMS365 Print Connector*") { throw "Installed setup screen did not start." }
    Add-Type -AssemblyName System.Security
    $savedAccess = Get-Content -LiteralPath (Join-Path $env:WMS365_PRINT_AGENT_DATA_DIR "loopback-access.json") -Raw | ConvertFrom-Json
    $tokenBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($savedAccess.protectedToken), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $localToken = [Text.Encoding]::UTF8.GetString($tokenBytes)
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8855/api/unlock" -Method POST -ContentType "application/json" -Body (@{ token = $localToken } | ConvertTo-Json) -SessionVariable localSession | Out-Null
    $setup = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8855" -WebSession $localSession
    if ($setup.Content -notlike "*Default letter printer*") { throw "Windows-protected setup did not unlock." }
    & $node (Join-Path $install "connector-security.js")
    if ($LASTEXITCODE -ne 0) { throw "Installed connector cryptography failed verification." }
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8855/api/status" | Out-Null; throw "Unauthenticated local API was not blocked." }
    catch { if ([int]$_.Exception.Response.StatusCode -ne 403) { throw } }
    $report = [ordered]@{ testedAt = [DateTime]::UtcNow.ToString("o"); packageSha256 = Get-WmsFileSha256 $PackagePath; installPassed = $true; runtimeVersion = (& $node --version); bundledPdfEngine = $true; setupStarted = $true; protectedApi = $true; physicalPrintingTested = $false; productionDatabaseTouched = $false }
    $report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output "installer-verification.json") -Encoding UTF8
    $report | ConvertTo-Json | Write-Host
} finally {
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force; $child.WaitForExit(10000) | Out-Null }
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], "Process") }
    $resolved = [IO.Path]::GetFullPath($smoke)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($output).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe smoke-test cleanup path." }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
